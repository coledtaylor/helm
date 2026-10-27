//! A frame over the size limit, or a truncated or malformed body, is a
//! protocol error, and the decoder never allocates what a frame claims.
//!
//! This file has its own global allocator that records the largest single
//! allocation made on the current thread, so each test can show that nothing
//! near the claimed length was ever requested.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

use floti_protocol::message::{Request, StreamData};
use floti_protocol::{
    Bytes, FrameDecoder, MAX_FRAME_LEN, Message, Payload, ProtocolError, encode_frame,
};

struct LargestAllocation;

thread_local! {
    static LARGEST: Cell<usize> = const { Cell::new(0) };
}

unsafe impl GlobalAlloc for LargestAllocation {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        record(layout.size());
        unsafe { System.alloc(layout) }
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        record(layout.size());
        unsafe { System.alloc_zeroed(layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        record(new_size);
        unsafe { System.realloc(ptr, layout, new_size) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) }
    }
}

fn record(size: usize) {
    let _ = LARGEST.try_with(|largest| largest.set(largest.get().max(size)));
}

#[global_allocator]
static ALLOCATOR: LargestAllocation = LargestAllocation;

/// The largest single allocation `work` made on this thread.
fn largest_allocation_during(work: impl FnOnce()) -> usize {
    LARGEST.with(|largest| largest.set(0));
    work();
    LARGEST.with(Cell::get)
}

const SMALL: usize = 64 * 1024;

#[test]
fn a_length_prefix_over_the_maximum_is_a_protocol_error_without_allocating_it() {
    for claimed in [MAX_FRAME_LEN + 1, u32::MAX] {
        let mut decoder = FrameDecoder::new();
        let mut result = Ok(None);
        let largest = largest_allocation_during(|| {
            decoder.push(&claimed.to_be_bytes());
            decoder.push(&[0xa0; 16]);
            result = decoder.next_message();
        });
        assert_eq!(
            result,
            Err(ProtocolError::FrameTooLarge {
                len: u64::from(claimed),
                max: MAX_FRAME_LEN
            })
        );
        assert!(
            largest < SMALL,
            "allocated {largest} bytes for a {claimed}-byte claim"
        );

        // Framing is lost, so the decoder stays failed.
        decoder.push(&encode_frame(&Message::Request(request())).unwrap());
        assert!(matches!(
            decoder.next_message(),
            Err(ProtocolError::FrameTooLarge { .. })
        ));
        assert_eq!(
            decoder.buffered(),
            0,
            "nothing is buffered after the failure"
        );
    }
}

#[test]
fn a_prefix_at_the_maximum_waits_for_its_bytes_without_reserving_them() {
    let mut decoder = FrameDecoder::new();
    let largest = largest_allocation_during(|| {
        decoder.push(&MAX_FRAME_LEN.to_be_bytes());
        decoder.push(&[0; 100]);
        assert_eq!(decoder.next_message(), Ok(None));
    });
    assert!(largest < SMALL, "allocated {largest} bytes while waiting");
    assert!(
        matches!(decoder.finish(), Err(ProtocolError::Truncated(_))),
        "the connection ended inside a frame"
    );
}

#[test]
fn a_body_that_ends_before_its_cbor_value_is_a_truncated_frame() {
    let frame = encode_frame(&Message::Request(request())).unwrap();
    let body = &frame[4..];
    for cut in [0, 1, body.len() / 2, body.len() - 1] {
        let mut short = (cut as u32).to_be_bytes().to_vec();
        short.extend_from_slice(&body[..cut]);
        let mut decoder = FrameDecoder::new();
        decoder.push(&short);
        assert!(
            matches!(decoder.next_message(), Err(ProtocolError::Truncated(_))),
            "body cut to {cut} bytes"
        );
    }
}

#[test]
fn a_byte_string_claiming_more_than_its_frame_holds_is_truncated_without_allocating_the_claim() {
    // A map {"type": "streamData", "stream": 1, "data": <bytes of length 2^62>}
    // with only four bytes of data after the header.
    let mut body = vec![0xa3];
    body.extend_from_slice(&[0x64, b't', b'y', b'p', b'e']);
    body.push(0x6a);
    body.extend_from_slice(b"streamData");
    body.extend_from_slice(&[0x66]);
    body.extend_from_slice(b"stream");
    body.push(0x01);
    body.extend_from_slice(&[0x64, b'd', b'a', b't', b'a']);
    body.push(0x5b); // byte string, 8-byte length follows
    body.extend_from_slice(&(1u64 << 62).to_be_bytes());
    body.extend_from_slice(&[1, 2, 3, 4]);

    let mut frame = (body.len() as u32).to_be_bytes().to_vec();
    frame.extend_from_slice(&body);
    let mut decoder = FrameDecoder::new();
    let mut result = Ok(None);
    let largest = largest_allocation_during(|| {
        decoder.push(&frame);
        result = decoder.next_message();
    });
    assert!(
        matches!(result, Err(ProtocolError::Truncated(_))),
        "got {result:?}"
    );
    assert!(
        largest < SMALL,
        "allocated {largest} bytes for a 2^62-byte claim"
    );
}

#[test]
fn a_body_that_is_not_one_well_formed_message_is_malformed_and_the_next_frame_still_decodes() {
    let reserved_additional_info = vec![0x1c]; // not well-formed CBOR
    let not_a_message = vec![0x63, b'a', b'b', b'c']; // a text string
    let mut two_values = encode_frame(&Message::Request(request())).unwrap()[4..].to_vec();
    two_values.push(0x00); // a second CBOR value after the first

    for body in [reserved_additional_info, not_a_message, two_values] {
        let mut bytes = (body.len() as u32).to_be_bytes().to_vec();
        bytes.extend_from_slice(&body);
        bytes.extend_from_slice(&encode_frame(&Message::Request(request())).unwrap());

        let mut decoder = FrameDecoder::new();
        decoder.push(&bytes);
        assert!(
            matches!(decoder.next_message(), Err(ProtocolError::Malformed(_))),
            "body {body:02x?}"
        );
        assert_eq!(
            decoder.next_message(),
            Ok(Some(Message::Request(request())))
        );
    }
}

#[test]
fn a_message_too_large_for_a_frame_is_refused_when_encoding() {
    let huge = Message::StreamData(StreamData {
        stream: 1,
        data: Bytes(vec![0; MAX_FRAME_LEN as usize + 1]),
    });
    assert!(matches!(encode_frame(&huge), Err(ProtocolError::Encode(_))));
}

fn request() -> Request {
    Request {
        id: 9,
        channel: "session:list".into(),
        payload: Payload::Null,
    }
}
