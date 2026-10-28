//! The process table and listening sockets on Windows.
//!
//! A Toolhelp snapshot lists every process with its parent and image name.
//! Each command line is asked of the process itself
//! (`NtQueryInformationProcess` with `ProcessCommandLineInformation`, opened
//! with `PROCESS_QUERY_LIMITED_INFORMATION`, the least access there is); a
//! process this user may not open, or a protected one that refuses, has none.
//! `GetExtendedTcpTable` lists the listening sockets of both families with
//! their owning pids.

use std::io;
use std::net::{Ipv4Addr, Ipv6Addr};

use windows_sys::Wdk::System::Threading::{
    NtQueryInformationProcess, ProcessCommandLineInformation,
};
use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_INSUFFICIENT_BUFFER, ERROR_NOT_SUPPORTED, INVALID_HANDLE_VALUE, NO_ERROR,
    STATUS_INFO_LENGTH_MISMATCH, UNICODE_STRING,
};
use windows_sys::Win32::NetworkManagement::IpHelper::{
    GetExtendedTcpTable, MIB_TCP6ROW_OWNER_PID, MIB_TCP6TABLE_OWNER_PID, MIB_TCPROW_OWNER_PID,
    MIB_TCPTABLE_OWNER_PID, TCP_TABLE_OWNER_PID_LISTENER,
};
use windows_sys::Win32::Networking::WinSock::{AF_INET, AF_INET6};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

use super::{PortRow, ProcessRow, ProcessTable};
use crate::{Error, Result};

/// The Windows implementation.
#[derive(Debug, Clone, Copy, Default)]
pub struct Native;

impl ProcessTable for Native {
    fn processes(&self) -> Result<Vec<ProcessRow>> {
        let mut rows = list_processes().map_err(|err| Error::io("list the processes", err))?;
        // One buffer for every command line, grown when one needs more.
        let mut buffer = Vec::new();
        for row in &mut rows {
            row.command_line = command_line(row.pid, &mut buffer);
        }
        Ok(rows)
    }

    fn listening(&self) -> Result<Vec<PortRow>> {
        let mut rows = listening_v4().map_err(|err| Error::io("list the IPv4 listeners", err))?;
        rows.extend(listening_v6().map_err(|err| Error::io("list the IPv6 listeners", err))?);
        Ok(rows)
    }
}

/// Every process, without command lines.
fn list_processes() -> io::Result<Vec<ProcessRow>> {
    // SAFETY: takes plain values and returns a snapshot handle or
    // INVALID_HANDLE_VALUE.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let mut rows = Vec::new();
    let mut entry = PROCESSENTRY32W {
        dwSize: u32::try_from(size_of::<PROCESSENTRY32W>()).expect("an entry's size fits"),
        ..PROCESSENTRY32W::default()
    };
    // SAFETY: `snapshot` is open, `entry` is sized as the calls require, and
    // the snapshot is closed once after the walk.
    let mut more = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
    while more {
        let name = &entry.szExeFile;
        let len = name
            .iter()
            .position(|unit| *unit == 0)
            .unwrap_or(name.len());
        rows.push(ProcessRow {
            pid: entry.th32ProcessID,
            parent_pid: entry.th32ParentProcessID,
            name: String::from_utf16_lossy(&name[..len]),
            command_line: None,
        });
        more = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
    }
    unsafe { CloseHandle(snapshot) };
    Ok(rows)
}

/// How much room a command line gets at first: most fit.
const FIRST_COMMAND_LINE_BYTES: usize = 4096;

/// Process `pid`'s command line, or `None` where Windows will not give it to
/// this user. `buffer` is reused between calls.
fn command_line(pid: u32, buffer: &mut Vec<u64>) -> Option<String> {
    if pid == 0 {
        return None;
    }
    // SAFETY: OpenProcess takes plain values and returns a handle or null.
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return None;
    }
    if buffer.is_empty() {
        buffer.resize(FIRST_COMMAND_LINE_BYTES / 8, 0);
    }
    let mut read = None;
    for _ in 0..2 {
        let capacity = u32::try_from(buffer.len() * 8).unwrap_or(u32::MAX);
        let mut needed = 0u32;
        // SAFETY: `process` is open with the access this class needs, and
        // `buffer` is `capacity` bytes, aligned for the UNICODE_STRING the
        // call writes at its start with the text after it.
        let status = unsafe {
            NtQueryInformationProcess(
                process,
                ProcessCommandLineInformation,
                buffer.as_mut_ptr().cast(),
                capacity,
                &mut needed,
            )
        };
        if status == STATUS_INFO_LENGTH_MISMATCH && needed as usize > buffer.len() * 8 {
            buffer.resize((needed as usize).div_ceil(8), 0);
            continue;
        }
        if status >= 0 {
            read = Some(unicode_string_in(buffer));
        }
        break;
    }
    // SAFETY: `process` was opened above and is closed once.
    unsafe { CloseHandle(process) };
    read.flatten().filter(|line| !line.is_empty())
}

/// The UNICODE_STRING at the start of `buffer`, whose text the call put in
/// the same buffer.
fn unicode_string_in(buffer: &[u64]) -> Option<String> {
    let start = buffer.as_ptr().cast::<u8>();
    let end = start.wrapping_add(buffer.len() * 8);
    // SAFETY: the buffer is at least as large as, and aligned for, a
    // UNICODE_STRING, which the call wrote there.
    let text = unsafe { std::ptr::read(buffer.as_ptr().cast::<UNICODE_STRING>()) };
    let units = usize::from(text.Length) / 2;
    let at = text.Buffer.cast::<u8>().cast_const();
    if units == 0 {
        return Some(String::new());
    }
    // The text has to lie inside the buffer; anything else is not trusted.
    if text.Buffer.is_null() || at < start || at.wrapping_add(units * 2) > end {
        return None;
    }
    // SAFETY: checked above to be `units` UTF-16 units inside `buffer`.
    let slice = unsafe { std::slice::from_raw_parts(text.Buffer.cast_const(), units) };
    Some(String::from_utf16_lossy(slice))
}

/// The table of listening sockets of `family`, as `GetExtendedTcpTable`
/// writes it, or `None` when the OS has no such family.
fn tcp_table(family: u16) -> io::Result<Option<Vec<u64>>> {
    let mut buffer: Vec<u64> = vec![0; 512];
    loop {
        let mut size = u32::try_from(buffer.len() * 8).unwrap_or(u32::MAX);
        // SAFETY: `buffer` is `size` bytes, aligned for the table; the call
        // writes at most that much and says how much it needs when it is
        // not enough.
        let status = unsafe {
            GetExtendedTcpTable(
                buffer.as_mut_ptr().cast(),
                &mut size,
                0,
                u32::from(family),
                TCP_TABLE_OWNER_PID_LISTENER,
                0,
            )
        };
        match status {
            NO_ERROR => return Ok(Some(buffer)),
            ERROR_INSUFFICIENT_BUFFER => buffer.resize((size as usize).div_ceil(8) + 64, 0),
            ERROR_NOT_SUPPORTED => return Ok(None),
            other => {
                return Err(io::Error::from_raw_os_error(
                    i32::try_from(other).unwrap_or(i32::MAX),
                ));
            }
        }
    }
}

/// The rows of a table written at the start of `buffer`: a count, then that
/// many rows of `Row`, laid out as `Table` says.
fn rows_of<Table, Row: Copy>(buffer: &[u64], count_of: fn(&Table) -> u32) -> Vec<Row> {
    let table = buffer.as_ptr().cast::<Table>();
    // SAFETY: the call wrote a `Table` at the start of `buffer`.
    let count = count_of(unsafe { &*table }) as usize;
    let offset = size_of::<Table>() - size_of::<Row>();
    let room = (buffer.len() * 8).saturating_sub(offset) / size_of::<Row>();
    let first = buffer
        .as_ptr()
        .cast::<u8>()
        .wrapping_add(offset)
        .cast::<Row>();
    // SAFETY: the rows follow the count, as the table's one-row array
    // declares, and no more are read than the buffer holds.
    unsafe { std::slice::from_raw_parts(first, count.min(room)) }.to_vec()
}

fn port_of(raw: u32) -> u16 {
    // The low 16 bits, in network byte order.
    u16::from_be(raw as u16)
}

fn listening_v4() -> io::Result<Vec<PortRow>> {
    let Some(buffer) = tcp_table(AF_INET)? else {
        return Ok(Vec::new());
    };
    let rows: Vec<MIB_TCPROW_OWNER_PID> =
        rows_of::<MIB_TCPTABLE_OWNER_PID, _>(&buffer, |table| table.dwNumEntries);
    Ok(rows
        .iter()
        .map(|row| PortRow {
            pid: row.dwOwningPid,
            port: port_of(row.dwLocalPort),
            // Stored in network byte order, as it lies in memory.
            address: Some(Ipv4Addr::from(row.dwLocalAddr.to_ne_bytes()).to_string()),
        })
        .collect())
}

fn listening_v6() -> io::Result<Vec<PortRow>> {
    let Some(buffer) = tcp_table(AF_INET6)? else {
        return Ok(Vec::new());
    };
    let rows: Vec<MIB_TCP6ROW_OWNER_PID> =
        rows_of::<MIB_TCP6TABLE_OWNER_PID, _>(&buffer, |table| table.dwNumEntries);
    Ok(rows
        .iter()
        .map(|row| PortRow {
            pid: row.dwOwningPid,
            port: port_of(row.dwLocalPort),
            address: Some(Ipv6Addr::from(row.ucLocalAddr).to_string()),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The System process is one no unelevated user may ask for a command
    /// line: it is listed with none, and the pass goes on.
    #[test]
    fn a_process_that_will_not_give_its_command_line_is_listed_without_one() {
        let rows = Native.processes().expect("the process table");
        let system = rows
            .iter()
            .find(|row| row.pid == 4)
            .expect("the System process");
        assert_eq!(system.command_line, None, "{system:?}");
        let this = rows
            .iter()
            .find(|row| row.pid == std::process::id())
            .expect("this process");
        assert!(this.command_line.is_some(), "{this:?}");
    }
}
