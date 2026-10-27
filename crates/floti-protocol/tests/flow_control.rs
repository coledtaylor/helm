//! Streams have credit-based flow control, and one stream out of credit
//! holds back nothing else.

use floti_protocol::message::{Response, StreamCredit, StreamData};
use floti_protocol::{
    Bytes, CreditReceiver, CreditSender, DEFAULT_INITIAL_CREDIT, FrameDecoder, Message, Outbox,
    Payload, ProtocolError, encode_frame,
};

#[test]
fn a_sender_with_n_bytes_of_credit_sends_at_most_n_and_holds_the_rest_until_more_arrives() {
    let mut sender = CreditSender::new(1, 10);
    sender.write(&[7; 25]);

    let first = sender.next_data(usize::MAX).unwrap();
    assert_eq!(first.data.len(), 10);
    assert_eq!(sender.next_data(usize::MAX), None, "no credit left");
    assert_eq!(sender.held(), 15);

    sender.grant(4);
    assert_eq!(sender.next_data(usize::MAX).unwrap().data.len(), 4);
    assert_eq!(sender.next_data(usize::MAX), None);

    sender.grant(1_000);
    assert_eq!(sender.next_data(usize::MAX).unwrap().data.len(), 11);
    assert_eq!(sender.held(), 0);
    assert_eq!(sender.credit(), 989);
}

#[test]
fn data_beyond_the_granted_credit_is_refused_as_a_protocol_error() {
    let mut receiver = CreditReceiver::new(1, 10);
    receiver
        .accept(&StreamData {
            stream: 1,
            data: Bytes(vec![0; 6]),
        })
        .unwrap();
    receiver
        .accept(&StreamData {
            stream: 1,
            data: Bytes(vec![0; 4]),
        })
        .unwrap();
    assert_eq!(
        receiver.accept(&StreamData {
            stream: 1,
            data: Bytes(vec![0; 1])
        }),
        Err(ProtocolError::CreditExceeded {
            stream: 1,
            len: 1,
            credit: 0
        })
    );

    let grant = receiver.grant(5);
    assert_eq!(
        grant,
        StreamCredit {
            stream: 1,
            bytes: 5
        }
    );
    assert_eq!(
        receiver.accept(&StreamData {
            stream: 1,
            data: Bytes(vec![0; 6])
        }),
        Err(ProtocolError::CreditExceeded {
            stream: 1,
            len: 6,
            credit: 5
        })
    );
    receiver
        .accept(&StreamData {
            stream: 1,
            data: Bytes(vec![0; 5]),
        })
        .unwrap();
}

#[test]
fn credit_round_trips_over_frames_between_a_sender_and_its_receiver() {
    let mut outbox = Outbox::new();
    outbox.open_stream(4, DEFAULT_INITIAL_CREDIT);
    let mut receiver = CreditReceiver::new(4, DEFAULT_INITIAL_CREDIT);
    let output = vec![b'x'; DEFAULT_INITIAL_CREDIT as usize + 1_000];
    outbox.write(4, &output).unwrap();

    let mut decoder = FrameDecoder::new();
    let mut received = Vec::new();
    for message in outbox.drain() {
        decoder.push(&encode_frame(&message).unwrap());
    }
    for message in decoder.drain().unwrap() {
        let Message::StreamData(data) = message else {
            panic!("expected stream data")
        };
        receiver.accept(&data).unwrap();
        received.extend_from_slice(data.data.as_slice());
    }
    assert_eq!(
        received.len() as u64,
        DEFAULT_INITIAL_CREDIT,
        "the default initial credit is 256 KiB"
    );
    assert_eq!(outbox.stream(4).unwrap().held(), 1_000);

    let grant = receiver.grant(DEFAULT_INITIAL_CREDIT);
    decoder.push(&encode_frame(&Message::StreamCredit(grant)).unwrap());
    let Some(Message::StreamCredit(credit)) = decoder.next_message().unwrap() else {
        panic!("expected credit")
    };
    outbox.grant(&credit).unwrap();
    for message in outbox.drain() {
        let Message::StreamData(data) = message else {
            panic!("expected stream data")
        };
        receiver.accept(&data).unwrap();
        received.extend_from_slice(data.data.as_slice());
    }
    assert_eq!(received, output);
}

fn response(id: u64) -> Message {
    Message::Response(Response {
        id,
        payload: Payload::Null,
    })
}

fn summarise(messages: &[Message]) -> Vec<String> {
    messages
        .iter()
        .map(|message| match message {
            Message::Response(response) => format!("response {}", response.id),
            Message::StreamData(data) => {
                format!("stream {} {} bytes", data.stream, data.data.len())
            }
            other => format!("{other:?}"),
        })
        .collect()
}

#[test]
fn a_stream_out_of_credit_holds_back_only_its_own_bytes() {
    let mut outbox = Outbox::new();
    outbox.open_stream(1, 4);
    outbox.open_stream(2, 4);
    outbox.write(1, &[1; 10]).unwrap();
    outbox.write(2, &[2; 10]).unwrap();
    outbox.push(response(100));

    assert_eq!(
        summarise(&outbox.drain()),
        ["response 100", "stream 1 4 bytes", "stream 2 4 bytes"]
    );

    // Stream 1 has no credit left and gets none. Stream 2 gets more, and
    // requests keep being answered.
    outbox
        .grant(&StreamCredit {
            stream: 2,
            bytes: 100,
        })
        .unwrap();
    outbox.push(response(101));
    outbox.push(response(102));
    assert_eq!(
        summarise(&outbox.drain()),
        ["response 101", "response 102", "stream 2 6 bytes"]
    );
    assert_eq!(outbox.stream(1).unwrap().held(), 6);

    outbox.write(2, &[2; 3]).unwrap();
    outbox.push(response(103));
    assert_eq!(
        summarise(&outbox.drain()),
        ["response 103", "stream 2 3 bytes"]
    );

    outbox
        .grant(&StreamCredit {
            stream: 1,
            bytes: 6,
        })
        .unwrap();
    assert_eq!(summarise(&outbox.drain()), ["stream 1 6 bytes"]);
}

#[test]
fn streams_with_credit_take_turns() {
    let mut outbox = Outbox::new();
    for stream in [1, 2, 3] {
        outbox.open_stream(stream, u64::MAX);
        outbox.write(stream, &vec![0; 200 * 1024]).unwrap();
    }
    let order: Vec<u64> = outbox
        .drain()
        .iter()
        .map(|message| match message {
            Message::StreamData(data) => data.stream,
            other => panic!("unexpected {other:?}"),
        })
        .take(6)
        .collect();
    assert_eq!(order, [1, 2, 3, 1, 2, 3]);
}

#[test]
fn data_credit_or_writes_for_a_stream_that_is_not_open_are_refused() {
    let mut outbox = Outbox::new();
    assert_eq!(outbox.write(9, b"x"), Err(ProtocolError::UnknownStream(9)));
    assert_eq!(
        outbox.grant(&StreamCredit {
            stream: 9,
            bytes: 1
        }),
        Err(ProtocolError::UnknownStream(9))
    );
    let mut receiver = CreditReceiver::new(1, 10);
    assert_eq!(
        receiver.accept(&StreamData {
            stream: 2,
            data: Bytes(vec![0])
        }),
        Err(ProtocolError::UnknownStream(2))
    );
}
