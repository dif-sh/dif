//! In-process HTTP server for cloud tests. One request per connection.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone)]
pub struct Request {
    pub method: String,
    pub path: String,
    pub body: String,
}

pub struct FakeServer {
    pub url: String,
    pub requests: Arc<Mutex<Vec<Request>>>,
}

impl FakeServer {
    /// `handler` returns the status and the JSON body.
    pub fn start<F>(handler: F) -> Self
    where
        F: Fn(&Request) -> (u16, String) + Send + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&requests);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                let mut parts = line.split_whitespace();
                let method = parts.next().unwrap_or_default().to_string();
                let path = parts.next().unwrap_or_default().to_string();
                let mut len = 0usize;
                loop {
                    let mut h = String::new();
                    reader.read_line(&mut h).unwrap();
                    let h = h.trim_end();
                    if h.is_empty() {
                        break;
                    }
                    let (name, value) = h.split_once(':').unwrap_or((h, ""));
                    if name.eq_ignore_ascii_case("content-length") {
                        len = value.trim().parse().unwrap_or(0);
                    }
                }
                let mut body = vec![0; len];
                reader.read_exact(&mut body).unwrap();
                let req = Request {
                    method,
                    path,
                    body: String::from_utf8_lossy(&body).into_owned(),
                };
                let (status, resp) = handler(&req);
                log.lock().unwrap().push(req);
                let head = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    resp.len()
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(resp.as_bytes());
            }
        });
        FakeServer { url, requests }
    }

    pub fn paths(&self) -> Vec<String> {
        let log = self.requests.lock().unwrap();
        log.iter().map(|r| r.path.clone()).collect()
    }
}
