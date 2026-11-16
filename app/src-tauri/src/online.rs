//! Open Library lookups for Edit details. Nothing is sent until you press Find details online, and then only
//! what's needed to look the book up (its title and author, or ISBN). Only Open Library's read-only pages and
//! cover images can be fetched; the comparing happens in the window (src/online.js).

use std::io::Read;
use std::time::Duration;

const SITE: &str = "https://openlibrary.org";
const COVERS: &str = "https://covers.openlibrary.org";
const AGENT: &str = concat!("Nightstand/", env!("CARGO_PKG_VERSION"), " (desktop ebook app)");

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new().timeout(Duration::from_secs(15)).user_agent(AGENT).build()
}

/// Paths the window may ask for. Anything else is refused.
fn allowed(path: &str) -> bool {
    let ok_start = ["/search.json?", "/works/", "/books/", "/isbn/", "/authors/"].iter().any(|p| path.starts_with(p));
    ok_start && !path.contains("..") && !path.contains("://") && path.chars().all(|c| c.is_ascii_graphic())
}

pub fn get(path: &str) -> Result<serde_json::Value, String> {
    if !allowed(path) {
        return Err(format!("not an Open Library lookup: {path}"));
    }
    match agent().get(&format!("{SITE}{path}")).call() {
        Ok(r) => serde_json::from_reader(r.into_reader().take(8 << 20)).map_err(|e| format!("Open Library sent something unexpected: {e}")),
        Err(ureq::Error::Status(404, _)) => Ok(serde_json::Value::Null),
        Err(ureq::Error::Status(code, _)) => Err(format!("Open Library answered {code}. Try again in a minute.")),
        Err(_) => Err("Couldn't reach Open Library. Check the internet connection.".into()),
    }
}

/// A cover image by Open Library's cover id, at its largest size.
pub fn cover(cover_id: i64) -> Result<Vec<u8>, String> {
    let r = agent()
        .get(&format!("{COVERS}/b/id/{cover_id}-L.jpg?default=false"))
        .call()
        .map_err(|e| match e {
            ureq::Error::Status(404, _) => "Open Library doesn't have that cover any more.".to_string(),
            _ => "Couldn't download the cover. Check the internet connection.".to_string(),
        })?;
    let mut bytes = vec![];
    r.into_reader().take(20 << 20).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_open_library_lookups() {
        assert!(allowed("/search.json?title=middlemarch&author=eliot"));
        assert!(allowed("/works/OL20867W.json"));
        assert!(allowed("/works/OL20867W/editions.json?limit=50"));
        assert!(allowed("/isbn/9780141439549.json"));
        assert!(!allowed("/account/login"));
        assert!(!allowed("/works/../account"));
        assert!(!allowed("/works/x?u=https://evil"));
        assert!(!allowed("/works/a b"));
    }
}
