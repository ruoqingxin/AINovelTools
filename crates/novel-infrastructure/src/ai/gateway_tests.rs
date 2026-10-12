use super::*;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::mpsc;

fn profile(base_url: String) -> ModelProfile {
    ModelProfile {
        id: Uuid::new_v4(),
        name: "Gateway fixture".into(),
        provider: ModelProvider::OpenAiCompatible,
        capability: ModelCapability::Chat,
        base_url,
        model_id: "fixture".into(),
        context_window: 4_096,
        max_output_tokens: 512,
        privacy_level: PrivacyLevel::AllowCloud,
        timeout_seconds: 5,
        retry_limit: 0,
        input_price_micros_per_million: 0,
        output_price_micros_per_million: 0,
        price_currency: "USD".into(),
        secret_ref: None,
        has_secret: false,
        created_at: String::new(),
        updated_at: String::new(),
    }
}

fn server(
    handler: impl FnOnce(std::net::TcpStream) + Send + 'static,
) -> (String, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let thread = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut request = Vec::new();
        let mut buffer = [0; 4_096];
        loop {
            let count = socket.read(&mut buffer).unwrap();
            assert!(count > 0);
            request.extend_from_slice(&buffer[..count]);
            if let Some(end) = request.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                let headers = std::str::from_utf8(&request[..end]).unwrap();
                let length: usize = headers
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(str::trim)
                            .map(str::to_owned)
                    })
                    .unwrap()
                    .parse()
                    .unwrap();
                if request.len() >= end + 4 + length {
                    break;
                }
            }
        }
        handler(socket);
    });
    (format!("http://{address}/v1"), thread)
}

#[tokio::test]
async fn stream_delivers_a_complete_event_before_the_response_ends() {
    let (release, held) = mpsc::channel();
    let (url, thread) = server(move |mut socket| {
        socket
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n",
            )
            .unwrap();
        socket
            .write_all(b"data: {\"choices\":[{\"delta\":{\"content\":\"first\"}}]}\n\n")
            .unwrap();
        socket.flush().unwrap();
        let _ = held.recv_timeout(Duration::from_secs(3));
        let _ = socket.write_all(b"data: {\"choices\":[{\"delta\":{\"content\":\" second\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n");
    });
    let gateway = ModelGateway::default();
    let mut observed = String::new();
    let result = tokio::time::timeout(
        Duration::from_secs(1),
        gateway.generate_detailed(
            &profile(url),
            None,
            &ContextPackage::connection_test(),
            true,
            false,
            Arc::new(AtomicBool::new(false)),
            |chunk| {
                observed.push_str(chunk);
                if chunk == "first" {
                    release.send(()).unwrap();
                }
            },
        ),
    )
    .await;
    drop(release);
    thread.join().unwrap();
    let output = result
        .expect("first chunk must release the still-open provider")
        .unwrap();
    assert_eq!(observed, "first second");
    assert_eq!(output.output, observed);
    assert_eq!(output.completion, GenerationCompletion::Complete);
}

#[tokio::test]
async fn cancellation_interrupts_waiting_for_headers_and_non_streaming_body() {
    for sent_headers in [false, true] {
        let (release, held) = mpsc::channel();
        let cancelled = Arc::new(AtomicBool::new(false));
        let provider_flag = Arc::clone(&cancelled);
        let (url, thread) = server(move |mut socket| {
            if sent_headers {
                socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 200\r\nConnection: close\r\n\r\n").unwrap();
                socket.flush().unwrap();
            }
            provider_flag.store(true, Ordering::Relaxed);
            let _ = held.recv_timeout(Duration::from_secs(3));
        });
        let result = tokio::time::timeout(
            Duration::from_millis(800),
            ModelGateway::default().generate_detailed(
                &profile(url),
                None,
                &ContextPackage::connection_test(),
                false,
                false,
                cancelled,
                |_| panic!("cancelled response must not emit text"),
            ),
        )
        .await;
        release.send(()).unwrap();
        thread.join().unwrap();
        assert!(matches!(result, Ok(Err(AiError::Cancelled))), "{result:?}");
    }
}

#[tokio::test]
async fn cancellation_interrupts_a_silent_open_stream() {
    let (release, held) = mpsc::channel();
    let cancelled = Arc::new(AtomicBool::new(false));
    let callback_flag = Arc::clone(&cancelled);
    let (url, thread) = server(move |mut socket| {
        socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {\"choices\":[{\"delta\":{\"content\":\"preview\"}}]}\n\n").unwrap();
        socket.flush().unwrap();
        let _ = held.recv_timeout(Duration::from_secs(3));
    });
    let mut chunks = Vec::new();
    let result = tokio::time::timeout(
        Duration::from_millis(800),
        ModelGateway::default().generate_detailed(
            &profile(url),
            None,
            &ContextPackage::connection_test(),
            true,
            false,
            cancelled,
            |chunk| {
                chunks.push(chunk.to_owned());
                callback_flag.store(true, Ordering::Relaxed);
            },
        ),
    )
    .await;
    release.send(()).unwrap();
    thread.join().unwrap();
    assert_eq!(chunks, ["preview"]);
    assert!(matches!(result, Ok(Err(AiError::Cancelled))), "{result:?}");
}

#[tokio::test]
async fn sse_handles_fragmented_unicode_multiline_data_crlf_and_usage() {
    let body = ": heartbeat\r\n\r\ndata: {\"choices\":[\r\ndata: {\"delta\":{\"content\":\"中文𠮷\"}}]}\r\n\r\ndata: {\"choices\":[{\"delta\":{\"content\":[{\"text\":\"尾声\"}]},\"finish_reason\":\"stop\"}]}\r\n\r\ndata: {\"choices\":[],\"usage\":{\"prompt_tokens\":12,\"completion_tokens\":5,\"prompt_cache_hit_tokens\":3,\"prompt_cache_miss_tokens\":9}}\r\n\r\ndata: [DONE]\r\n\r\n";
    let (url, thread) = server(move |mut socket| {
        socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n").unwrap();
        for byte in body.as_bytes() {
            socket
                .write_all(&[b'1', b'\r', b'\n', *byte, b'\r', b'\n'])
                .unwrap();
        }
        let _ = socket.write_all(b"0\r\n\r\n");
    });
    let output = ModelGateway::default()
        .generate_detailed(
            &profile(url),
            None,
            &ContextPackage::connection_test(),
            true,
            false,
            Arc::new(AtomicBool::new(false)),
            |_| {},
        )
        .await
        .unwrap();
    thread.join().unwrap();
    assert_eq!(output.output, "中文𠮷尾声");
    assert_eq!(output.completion, GenerationCompletion::Complete);
    assert_eq!(
        output.usage,
        Some(GenerationUsage {
            input_tokens: 12,
            output_tokens: 5,
            input_cache_hit_tokens: Some(3),
            input_cache_miss_tokens: Some(9),
        })
    );
}

#[tokio::test]
async fn done_finishes_even_when_the_http_connection_stays_open() {
    let (release, held) = mpsc::channel();
    let (url, thread) = server(move |mut socket| {
        socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {\"choices\":[{\"delta\":{\"content\":\"done\"}}]}\n\ndata: [DONE]\n\n").unwrap();
        socket.flush().unwrap();
        let _ = held.recv_timeout(Duration::from_secs(3));
    });
    let result = tokio::time::timeout(
        Duration::from_secs(1),
        ModelGateway::default().generate_detailed(
            &profile(url),
            None,
            &ContextPackage::connection_test(),
            true,
            false,
            Arc::new(AtomicBool::new(false)),
            |_| {},
        ),
    )
    .await;
    release.send(()).unwrap();
    thread.join().unwrap();
    assert_eq!(
        result.unwrap().unwrap().completion,
        GenerationCompletion::Complete
    );
}

#[tokio::test]
async fn json_stream_fallback_and_incomplete_completions_keep_their_metadata() {
    for (mime, body, completion, text) in [
        (
            "application/json; charset=utf-8",
            r#"{"choices":[{"message":{"content":"JSON response"},"finish_reason":"stop"}]}"#,
            GenerationCompletion::Complete,
            "JSON response",
        ),
        (
            "text/event-stream",
            "data: {\"choices\":[{\"delta\":{\"content\":\"half\"},\"finish_reason\":\"length\"}]}\n\ndata: [DONE]\n\n",
            GenerationCompletion::LengthLimit,
            "half",
        ),
        (
            "text/event-stream",
            "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n",
            GenerationCompletion::Interrupted,
            "partial",
        ),
        (
            "text/event-stream",
            "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"not prose\"},\"finish_reason\":\"length\"}]}\n\ndata: [DONE]\n\n",
            GenerationCompletion::LengthLimit,
            "",
        ),
    ] {
        let (url, thread) = server(move |mut socket| {
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            socket.write_all(response.as_bytes()).unwrap();
        });
        let output = ModelGateway::default()
            .generate_detailed(
                &profile(url),
                None,
                &ContextPackage::connection_test(),
                true,
                false,
                Arc::new(AtomicBool::new(false)),
                |_| {},
            )
            .await
            .unwrap();
        thread.join().unwrap();
        assert_eq!(output.completion, completion);
        assert_eq!(output.output, text);
    }
}

#[tokio::test]
async fn invalid_sse_json_and_utf8_fail_instead_of_publishing_partial_output() {
    for body in [
        b"data: {not-json}\n\n".as_slice(),
        b"data: {\"choices\":[{\"delta\":{\"content\":\"\xff\"}}]}\n\n".as_slice(),
        b"data: {\"choices\":[{\"delta\":{\"content\":\"preview\"}}]}\n\ndata: invalid\n\n"
            .as_slice(),
    ] {
        let (url, thread) = server(move |mut socket| {
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            socket.write_all(header.as_bytes()).unwrap();
            socket.write_all(body).unwrap();
        });
        let result = ModelGateway::default()
            .generate_detailed(
                &profile(url),
                None,
                &ContextPackage::connection_test(),
                true,
                false,
                Arc::new(AtomicBool::new(false)),
                |_| {},
            )
            .await;
        thread.join().unwrap();
        assert!(
            matches!(result, Err(AiError::InvalidResponse)),
            "{result:?}"
        );
    }
}

#[tokio::test]
async fn body_timeout_is_a_timeout_not_invalid_json() {
    let (release, held) = mpsc::channel();
    let (url, thread) = server(move |mut socket| {
        socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 200\r\nConnection: close\r\n\r\n").unwrap();
        socket.flush().unwrap();
        let _ = held.recv_timeout(Duration::from_secs(3));
    });
    let mut p = profile(url);
    p.timeout_seconds = 1;
    let result = ModelGateway::default()
        .generate_detailed(
            &p,
            None,
            &ContextPackage::connection_test(),
            false,
            false,
            Arc::new(AtomicBool::new(false)),
            |_| {},
        )
        .await;
    release.send(()).unwrap();
    thread.join().unwrap();
    assert!(matches!(result, Err(AiError::Timeout)), "{result:?}");
}
