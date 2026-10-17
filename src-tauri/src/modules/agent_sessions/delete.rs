use serde::{Deserialize, Serialize};

/// What the frontend may send: a tool name and an id. Paths are resolved on this
/// side from the tool's own store, never accepted from the caller.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTarget {
    pub tool: String,
    pub id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteOutcome {
    pub tool: String,
    pub id: String,
    pub deleted: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteReport {
    pub deleted: usize,
    pub outcomes: Vec<DeleteOutcome>,
}

const MAX_ID_BYTES: usize = 128;

/// An id reaches a filesystem lookup and a process argument list, so only the
/// shape both tools actually use is let through. No escaping, no repair.
pub(crate) fn validate_session_id(id: &str) -> Result<(), String> {
    let valid = !id.is_empty()
        && id.len() <= MAX_ID_BYTES
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if valid {
        Ok(())
    } else {
        Err(format!("非法的会话 id：{id}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_the_two_real_id_shapes() {
        assert!(validate_session_id("ses_0be16f2c8ffeFnRn5CVN2D7Xay").is_ok());
        assert!(validate_session_id("01a147ad-023f-71ff-b404-bb337dea4b63").is_ok());
    }

    #[test]
    fn rejects_anything_that_could_escape_a_path() {
        for id in [
            "",
            "..",
            "../x",
            "..\\x",
            "a/b",
            "a\\b",
            "C:\\Windows\\system32",
            "/etc/passwd",
            "a b",
            "a\"b",
            "a'b",
            "a;b",
            "ses_x$()",
            "ses_x\n",
            "ses_x\0",
        ] {
            assert!(validate_session_id(id).is_err(), "should reject {id:?}");
        }
    }

    #[test]
    fn rejects_an_overlong_id() {
        assert!(validate_session_id(&"a".repeat(129)).is_err());
        assert!(validate_session_id(&"a".repeat(128)).is_ok());
    }
}