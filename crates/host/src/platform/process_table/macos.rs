//! The process table and listening sockets on macOS, through `libproc` and
//! `sysctl`.
//!
//! `proc_listallpids` lists the processes; `proc_pidinfo` gives each one's
//! parent (`PROC_PIDTBSDINFO`, or the short form for a process of another
//! user's), and its name is the file name of `proc_pidpath`, as `ps -o comm`
//! shows it. The command line is the arguments `sysctl` `KERN_PROCARGS2`
//! gives, which it refuses for another user's process. The listening sockets
//! are each process's descriptors (`PROC_PIDLISTFDS`) asked as sockets
//! (`PROC_PIDFDSOCKETINFO`), keeping TCP ones in LISTEN; a wildcard bind
//! reads as `0.0.0.0` or `::`. Descriptors of another user's process cannot
//! be read, as with `lsof` run by the same user.

use std::ffi::{CStr, c_int, c_void};
use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::path::Path;

use super::{PortRow, ProcessRow, ProcessTable};
use crate::{Error, Result};

/// The Darwin implementation.
#[derive(Debug, Clone, Copy, Default)]
pub struct Native;

impl ProcessTable for Native {
    fn processes(&self) -> Result<Vec<ProcessRow>> {
        let pids = all_pids().map_err(|err| Error::io("list the processes", err))?;
        let mut arguments = vec![0u8; arg_max()];
        Ok(pids
            .into_iter()
            .filter_map(|pid| {
                let (parent_pid, short_name) = parent_and_name(pid)?;
                Some(ProcessRow {
                    pid: u32::try_from(pid).ok()?,
                    parent_pid,
                    name: path_name(pid).unwrap_or(short_name),
                    command_line: command_line(pid, &mut arguments),
                })
            })
            .collect())
    }

    fn listening(&self) -> Result<Vec<PortRow>> {
        let pids = all_pids().map_err(|err| Error::io("list the processes", err))?;
        let mut rows = Vec::new();
        for pid in pids {
            let Ok(owner) = u32::try_from(pid) else {
                continue;
            };
            for fd in socket_fds(pid) {
                if let Some((port, address)) = tcp_listener(pid, fd) {
                    rows.push(PortRow {
                        pid: owner,
                        port,
                        address: Some(address.to_string()),
                    });
                }
            }
        }
        Ok(rows)
    }
}

/// Every pid on the machine.
fn all_pids() -> io::Result<Vec<c_int>> {
    // SAFETY: with no buffer, the call answers how many pids there are.
    let count = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
    if count <= 0 {
        return Err(io::Error::last_os_error());
    }
    // Room for processes started between the two calls.
    let mut pids: Vec<c_int> = vec![0; usize::try_from(count).unwrap_or(0) + 64];
    let bytes = c_int::try_from(pids.len() * size_of::<c_int>()).unwrap_or(c_int::MAX);
    // SAFETY: `pids` is `bytes` long; the call writes at most that and
    // answers how many it wrote.
    let listed = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), bytes) };
    if listed <= 0 {
        return Err(io::Error::last_os_error());
    }
    pids.truncate(usize::try_from(listed).unwrap_or(0).min(pids.len()));
    pids.retain(|pid| *pid > 0);
    Ok(pids)
}

/// `pid`'s parent and its short name, or `None` once it has ended.
fn parent_and_name(pid: c_int) -> Option<(u32, String)> {
    // SAFETY: an all-zero proc_bsdinfo is valid, and the call writes at most
    // its size.
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = c_int::try_from(size_of::<libc::proc_bsdinfo>()).ok()?;
    let read = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            std::ptr::from_mut(&mut info).cast::<c_void>(),
            size,
        )
    };
    if read == size {
        let name = c_name(&info.pbi_name);
        let name = if name.is_empty() {
            c_name(&info.pbi_comm)
        } else {
            name
        };
        return Some((info.pbi_ppid, name));
    }
    // Another user's process answers only the short form.
    // SAFETY: as above, for the short form.
    let mut short: libc::proc_bsdshortinfo = unsafe { std::mem::zeroed() };
    let size = c_int::try_from(size_of::<libc::proc_bsdshortinfo>()).ok()?;
    let read = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDT_SHORTBSDINFO,
            0,
            std::ptr::from_mut(&mut short).cast::<c_void>(),
            size,
        )
    };
    (read == size).then(|| (short.pbsi_ppid, c_name(&short.pbsi_comm)))
}

/// A fixed-size C string field as text.
fn c_name(field: &[libc::c_char]) -> String {
    let bytes: Vec<u8> = field
        .iter()
        .take_while(|c| **c != 0)
        .map(|c| *c as u8)
        .collect();
    String::from_utf8_lossy(&bytes).into_owned()
}

/// The file name of `pid`'s executable.
fn path_name(pid: c_int) -> Option<String> {
    let mut path = vec![0u8; usize::try_from(libc::PROC_PIDPATHINFO_MAXSIZE).ok()?];
    let size = u32::try_from(path.len()).ok()?;
    // SAFETY: `path` is `size` bytes and the call writes a C string into it.
    let len = unsafe { libc::proc_pidpath(pid, path.as_mut_ptr().cast(), size) };
    if len <= 0 {
        return None;
    }
    let path = CStr::from_bytes_until_nul(&path).ok()?.to_str().ok()?;
    Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
}

/// The most argument bytes a process can have, the buffer `KERN_PROCARGS2`
/// is read into.
fn arg_max() -> usize {
    let mut mib = [libc::CTL_KERN, libc::KERN_ARGMAX];
    let mut value: c_int = 0;
    let mut size = size_of::<c_int>();
    // SAFETY: reads one int into `value`.
    let read = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            2,
            std::ptr::from_mut(&mut value).cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    match usize::try_from(value) {
        Ok(max) if read == 0 && max > 0 => max,
        _ => 1 << 20,
    }
}

/// `pid`'s command line, or `None` where the OS will not give it.
/// `buffer` is reused between calls.
fn command_line(pid: c_int, buffer: &mut [u8]) -> Option<String> {
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
    let mut size = buffer.len();
    // SAFETY: `buffer` is `size` bytes; the call writes at most that and
    // says how much it wrote.
    let read = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            3,
            buffer.as_mut_ptr().cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if read != 0 {
        return None;
    }
    parse_procargs(buffer.get(..size)?)
}

/// The arguments in a `KERN_PROCARGS2` answer: `argc`, the executable's
/// path, NUL padding, then `argc` NUL-terminated arguments, joined with
/// spaces.
fn parse_procargs(bytes: &[u8]) -> Option<String> {
    let argc = i32::from_ne_bytes(bytes.get(..4)?.try_into().ok()?);
    let rest = bytes.get(4..)?;
    let mut at = rest.iter().position(|byte| *byte == 0)?;
    while rest.get(at) == Some(&0) {
        at += 1;
    }
    let mut arguments = Vec::new();
    for _ in 0..argc {
        if at >= rest.len() {
            break;
        }
        let end = rest[at..]
            .iter()
            .position(|byte| *byte == 0)
            .map_or(rest.len(), |len| at + len);
        arguments.push(String::from_utf8_lossy(&rest[at..end]).into_owned());
        at = end + 1;
    }
    (!arguments.is_empty()).then(|| arguments.join(" "))
}

/// The descriptors of `pid` that are sockets; none for a process this user
/// may not read.
fn socket_fds(pid: c_int) -> Vec<c_int> {
    // SAFETY: with no buffer, the call answers how many bytes the list takes.
    let bytes =
        unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDLISTFDS, 0, std::ptr::null_mut(), 0) };
    let Ok(bytes) = usize::try_from(bytes) else {
        return Vec::new();
    };
    let each = size_of::<libc::proc_fdinfo>();
    // Room for descriptors opened between the two calls.
    let mut fds: Vec<libc::proc_fdinfo> = (0..bytes / each + 16)
        // SAFETY: an all-zero proc_fdinfo is valid.
        .map(|_| unsafe { std::mem::zeroed() })
        .collect();
    let room = c_int::try_from(fds.len() * each).unwrap_or(c_int::MAX);
    // SAFETY: `fds` is `room` bytes; the call writes at most that.
    let read =
        unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDLISTFDS, 0, fds.as_mut_ptr().cast(), room) };
    let Ok(read) = usize::try_from(read) else {
        return Vec::new();
    };
    fds.truncate((read / each).min(fds.len()));
    fds.iter()
        .filter(|fd| fd.proc_fdtype == libc::PROX_FDTYPE_SOCKET as u32)
        .map(|fd| fd.proc_fd)
        .collect()
}

// What `PROC_PIDFDSOCKETINFO` answers, from `<sys/proc_info.h>`, which the
// libc crate does not declare. Only what a listener needs is named; the rest
// of the answer lands in padding. Their fields are read by the kernel's
// layout, not by name, so most are never read here.

const PROC_PIDFDSOCKETINFO: c_int = 3;
const SOCKINFO_TCP: c_int = 2;
const TSI_S_LISTEN: c_int = 1;
const INI_IPV6: u8 = 0x2;

#[repr(C)]
#[allow(dead_code)]
struct ProcFileInfo {
    fi_openflags: u32,
    fi_status: u32,
    fi_offset: i64,
    fi_type: i32,
    fi_guardflags: u32,
}

#[repr(C)]
#[allow(dead_code)]
struct VinfoStat {
    vst_dev: u32,
    vst_mode: u16,
    vst_nlink: u16,
    vst_ino: u64,
    vst_uid: u32,
    vst_gid: u32,
    vst_times: [i64; 8],
    vst_size: i64,
    vst_blocks: i64,
    vst_blksize: i32,
    vst_flags: u32,
    vst_gen: u32,
    vst_rdev: u32,
    vst_qspare: [i64; 2],
}

#[repr(C)]
#[allow(dead_code)]
struct SockbufInfo {
    sbi_cc: u32,
    sbi_hiwat: u32,
    sbi_mbcnt: u32,
    sbi_mbmax: u32,
    sbi_lowat: u32,
    sbi_flags: i16,
    sbi_timeo: i16,
}

#[repr(C)]
#[allow(dead_code)]
struct InSockInfoV6 {
    in6_hlim: u8,
    in6_cksum: i32,
    in6_ifindex: u16,
    in6_hops: i16,
}

#[repr(C)]
#[allow(dead_code)]
struct InSockInfo {
    insi_fport: c_int,
    insi_lport: c_int,
    insi_gencnt: u64,
    insi_flags: u32,
    insi_flow: u32,
    insi_vflag: u8,
    insi_ip_ttl: u8,
    rfu_1: u32,
    /// An `in4in6_addr` (the IPv4 address in its last four bytes) or an
    /// `in6_addr`.
    insi_faddr: [u32; 4],
    insi_laddr: [u32; 4],
    insi_v4: u8,
    insi_v6: InSockInfoV6,
}

#[repr(C)]
#[allow(dead_code)]
struct TcpSockInfo {
    tcpsi_ini: InSockInfo,
    tcpsi_state: c_int,
}

#[repr(C)]
#[allow(dead_code)]
union SocketProto {
    pri_tcp: std::mem::ManuallyDrop<TcpSockInfo>,
    /// Room for the largest member, the Unix-domain one, and to spare.
    _room: [u64; 128],
}

#[repr(C)]
#[allow(dead_code)]
struct SocketInfo {
    soi_stat: VinfoStat,
    soi_so: u64,
    soi_pcb: u64,
    soi_type: c_int,
    soi_protocol: c_int,
    soi_family: c_int,
    soi_options: i16,
    soi_linger: i16,
    soi_state: i16,
    soi_qlen: i16,
    soi_incqlen: i16,
    soi_qlimit: i16,
    soi_timeo: i16,
    soi_error: u16,
    soi_oobmark: u32,
    soi_rcv: SockbufInfo,
    soi_snd: SockbufInfo,
    soi_kind: c_int,
    rfu_1: u32,
    soi_proto: SocketProto,
}

#[repr(C)]
#[allow(dead_code)]
struct SocketFdInfo {
    pfi: ProcFileInfo,
    psi: SocketInfo,
}

/// The port and local address of descriptor `fd` of `pid`, when it is a TCP
/// socket listening.
fn tcp_listener(pid: c_int, fd: c_int) -> Option<(u16, IpAddr)> {
    // SAFETY: an all-zero answer is valid, and the call writes at most its
    // size.
    let mut info: SocketFdInfo = unsafe { std::mem::zeroed() };
    let size = c_int::try_from(size_of::<SocketFdInfo>()).ok()?;
    let read = unsafe {
        libc::proc_pidfdinfo(
            pid,
            fd,
            PROC_PIDFDSOCKETINFO,
            std::ptr::from_mut(&mut info).cast::<c_void>(),
            size,
        )
    };
    let wanted = std::mem::offset_of!(SocketFdInfo, psi)
        + std::mem::offset_of!(SocketInfo, soi_proto)
        + size_of::<TcpSockInfo>();
    if usize::try_from(read).ok()? < wanted {
        return None;
    }
    let socket = &info.psi;
    if socket.soi_kind != SOCKINFO_TCP
        || (socket.soi_family != libc::AF_INET && socket.soi_family != libc::AF_INET6)
    {
        return None;
    }
    // SAFETY: a socket of kind SOCKINFO_TCP carries its TCP member.
    let tcp = unsafe { &socket.soi_proto.pri_tcp };
    if tcp.tcpsi_state != TSI_S_LISTEN {
        return None;
    }
    let ini = &tcp.tcpsi_ini;
    // The port in network byte order, widened to an int.
    let port = u16::from_be(ini.insi_lport as u16);
    let bytes: Vec<u8> = ini
        .insi_laddr
        .iter()
        .flat_map(|word| word.to_ne_bytes())
        .collect();
    let address = if ini.insi_vflag & INI_IPV6 != 0 {
        IpAddr::V6(Ipv6Addr::from(<[u8; 16]>::try_from(bytes).ok()?))
    } else {
        IpAddr::V4(Ipv4Addr::new(bytes[12], bytes[13], bytes[14], bytes[15]))
    };
    Some((port, address))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_arguments_of_a_procargs_answer_are_joined_after_the_path_and_its_padding() {
        let mut answer = 3i32.to_ne_bytes().to_vec();
        answer.extend_from_slice(
            b"/usr/local/bin/node\0\0\0\0node\0server.mjs\0--port 5173\0PATH=/bin\0",
        );
        assert_eq!(
            parse_procargs(&answer).as_deref(),
            Some("node server.mjs --port 5173")
        );
        assert_eq!(parse_procargs(&0i32.to_ne_bytes()), None);
        assert_eq!(parse_procargs(b"no"), None);
    }

    #[test]
    fn the_socket_answer_is_laid_out_as_the_kernel_writes_it() {
        assert_eq!(size_of::<ProcFileInfo>(), 24);
        assert_eq!(size_of::<VinfoStat>(), 136);
        assert_eq!(size_of::<InSockInfo>(), 80);
        assert_eq!(std::mem::offset_of!(SocketInfo, soi_kind), 232);
        assert_eq!(std::mem::offset_of!(SocketInfo, soi_proto), 240);
        assert_eq!(std::mem::offset_of!(TcpSockInfo, tcpsi_state), 80);
    }
}
