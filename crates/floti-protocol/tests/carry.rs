//! A client's own data carried into the host: `carry:*`. Seven requests, no
//! capability, and batches that read in camel case as the client builds them.

use floti_protocol::channel::{from_payload, to_payload};
use floti_protocol::channels::carry::{
    CarriedConfigVersion, CarriedConversation, CarriedConversationPart, CarriedConversations,
    CarriedUsageRow, CarriedUsageRows, CarryConversations, CarryFinish, CarryMissing, CarryNames,
    CarryStatusRead, CarryUsage, CarryVersions,
};
use floti_protocol::channels::sessions::{ArchiveMessage, ArchiveRole, ArchiveSessionState};
use floti_protocol::{Catalogue, ChannelKind, RequestChannel};
use serde_json::json;

#[test]
fn the_carry_channels_are_seven_requests_needing_no_capability() {
    let catalogue = Catalogue::protocol();
    let names = [
        CarryStatusRead::NAME,
        CarryMissing::NAME,
        CarryNames::NAME,
        CarryVersions::NAME,
        CarryUsage::NAME,
        CarryConversations::NAME,
        CarryFinish::NAME,
    ];
    assert_eq!(
        names,
        [
            "carry:status",
            "carry:missing",
            "carry:names",
            "carry:versions",
            "carry:usage",
            "carry:conversations",
            "carry:finish",
        ]
    );
    for name in names {
        let decl = catalogue
            .get(name)
            .unwrap_or_else(|| panic!("`{name}` is declared"));
        assert_eq!(decl.kind(), ChannelKind::Request, "{name}");
        assert_eq!(decl.capability(), None, "{name}");
    }
    let declared: Vec<&str> = catalogue
        .channels()
        .map(|decl| decl.name())
        .filter(|name| name.starts_with("carry:"))
        .collect();
    assert_eq!(declared.len(), names.len(), "{declared:?}");
}

#[test]
fn a_conversation_part_and_a_usage_row_read_in_camel_case() {
    let parts = CarriedConversations {
        parts: vec![CarriedConversationPart {
            conversation: CarriedConversation {
                session_id: "abc".into(),
                source_file: "C:\\a folder\\abc.jsonl".into(),
                state: ArchiveSessionState::Archived,
                first_at: Some(1),
                last_at: Some(2),
                message_count: 1,
                raw_bytes: 5,
                stored_bytes: 5,
                captured_at: "2026-10-01T00:00:00.000Z".into(),
                evicted_at: None,
            },
            part: 0,
            messages: vec![ArchiveMessage {
                uuid: "u1".into(),
                role: ArchiveRole::User,
                at: 1,
                text: "hello".into(),
            }],
            last: true,
        }],
    };
    let wire: serde_json::Value = from_payload(&to_payload(&parts).unwrap()).unwrap();
    assert_eq!(
        wire,
        json!({ "parts": [{
            "conversation": {
                "sessionId": "abc", "sourceFile": "C:\\a folder\\abc.jsonl", "state": "archived",
                "firstAt": 1, "lastAt": 2, "messageCount": 1, "rawBytes": 5, "storedBytes": 5,
                "capturedAt": "2026-10-01T00:00:00.000Z", "evictedAt": null,
            },
            "part": 0,
            "messages": [{ "uuid": "u1", "role": "user", "at": 1, "text": "hello" }],
            "last": true,
        }]})
    );
    let back: CarriedConversations = from_payload(&to_payload(&wire).unwrap()).unwrap();
    assert_eq!(back, parts);

    let usage = CarriedUsageRows {
        rows: vec![CarriedUsageRow {
            uuid: "u2".into(),
            at: 3,
            model: "claude-opus-4-1".into(),
            input: 1,
            output: 2,
            cache_write5m: 3,
            cache_write1h: 4,
            cache_read: 5,
        }],
    };
    let wire: serde_json::Value = from_payload(&to_payload(&usage).unwrap()).unwrap();
    assert_eq!(
        wire,
        json!({ "rows": [{
            "uuid": "u2", "at": 3, "model": "claude-opus-4-1", "input": 1, "output": 2,
            "cacheWrite5m": 3, "cacheWrite1h": 4, "cacheRead": 5,
        }]})
    );

    let version: serde_json::Value = from_payload(
        &to_payload(&CarriedConfigVersion {
            scope_path: "C:\\a repo".into(),
            file_path: ".claude/settings.json".into(),
            content: "{}".into(),
            content_hash: "44136fa3".into(),
            reason: "edit".into(),
            created_at: "2026-10-01T00:00:00.000Z".into(),
        })
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        version,
        json!({
            "scopePath": "C:\\a repo", "filePath": ".claude/settings.json", "content": "{}",
            "contentHash": "44136fa3", "reason": "edit", "createdAt": "2026-10-01T00:00:00.000Z",
        })
    );
}
