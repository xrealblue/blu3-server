use std::env;
use std::fs;
use std::process;

use anyhow::{anyhow, Context, Result};
use reqwest::header::{HeaderMap, HeaderValue};
use serde::Serialize;

static CLIENT_VERSION: &str = "19.30.36";
static USER_AGENT: &str = "com.google.android.youtube/19.30.36 (Linux; U; Android 14; en_US) gzip";
static API_KEY: &str = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";

#[derive(Serialize)]
struct Output {
    url: String,
    content_length: u64,
    mime_type: String,
}

fn parse_netscape_cookies(path: &str) -> Result<String> {
    let text = fs::read_to_string(path).context("Failed to read cookies file")?;
    let mut pairs: Vec<String> = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed == "#" || trimmed.starts_with("# ") {
            continue;
        }
        let parts: Vec<&str> = trimmed.split('\t').collect();
        if parts.len() >= 7 {
            let name = parts[5].trim();
            let value = parts[6].trim();
            if !name.is_empty() && !value.is_empty() {
                pairs.push(format!("{}={}", name, value));
            }
        }
    }
    if pairs.is_empty() {
        Err(anyhow!("No cookies found in {}", path))
    } else {
        Ok(pairs.join("; "))
    }
}

fn main() {
    let result = run();
    match result {
        Ok(output) => {
            println!("{}", serde_json::to_string(&output).unwrap());
        }
        Err(e) => {
            eprintln!("{}", e);
            process::exit(1);
        }
    }
}

fn run() -> Result<Output> {
    let args: Vec<String> = env::args().collect();
    let mut video_id = String::new();
    let mut cookies_path: Option<String> = None;

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--video-id" => {
                i += 1;
                video_id = args
                    .get(i)
                    .ok_or_else(|| anyhow!("--video-id requires a value"))?
                    .clone();
            }
            "--cookies" => {
                i += 1;
                cookies_path = Some(
                    args.get(i)
                        .ok_or_else(|| anyhow!("--cookies requires a value"))?
                        .clone(),
                );
            }
            _ => return Err(anyhow!("Unknown argument: {}", args[i])),
        }
        i += 1;
    }

    if video_id.is_empty() {
        return Err(anyhow!("--video-id is required"));
    }

    let cookie_header = match &cookies_path {
        Some(path) if fs::metadata(path).is_ok() => {
            parse_netscape_cookies(path).unwrap_or_default()
        }
        _ => String::new(),
    };

    let mut headers = HeaderMap::new();
    headers.insert("X-YouTube-Client-Name", HeaderValue::from_static("3"));
    headers.insert(
        "X-YouTube-Client-Version",
        HeaderValue::from_static(CLIENT_VERSION),
    );
    headers.insert(
        "Content-Type",
        HeaderValue::from_static("application/json"),
    );
    headers.insert("Origin", HeaderValue::from_static("https://www.youtube.com"));
    headers.insert(
        "Referer",
        HeaderValue::from_str(&format!("https://www.youtube.com/watch?v={video_id}"))?,
    );
    headers.insert("Accept-Encoding", HeaderValue::from_static("gzip"));
    if !cookie_header.is_empty() {
        headers.insert("Cookie", HeaderValue::from_str(&cookie_header)?);
    }

    let client = reqwest::blocking::Client::builder()
        .user_agent(USER_AGENT)
        .default_headers(headers)
        .build()
        .context("Failed to build HTTP client")?;

    let body = serde_json::json!({
        "videoId": video_id,
        "context": {
            "client": {
                "clientName": "ANDROID",
                "clientVersion": CLIENT_VERSION,
                "androidSdkVersion": 34,
                "userAgent": USER_AGENT,
                "osName": "Android",
                "osVersion": "14",
                "platform": "MOBILE",
                "hl": "en",
                "gl": "US",
                "timeZone": "UTC",
                "utcOffsetMinutes": 0
            }
        },
        "contentCheckOk": true,
        "racyCheckOk": true
    });

    let resp = client
        .post(format!(
            "https://www.youtube.com/youtubei/v1/player?key={API_KEY}"
        ))
        .json(&body)
        .send()
        .context("InnerTube request failed")?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().unwrap_or_default();
        return Err(anyhow!("InnerTube returned {}: {}", status, text));
    }

    let data: serde_json::Value = resp.json().context("Failed to parse InnerTube response")?;

    // Check playability
    let playability = data["playabilityStatus"]["status"]
        .as_str()
        .unwrap_or("UNKNOWN");
    if playability != "OK" {
        let reason = data["playabilityStatus"]["reason"]
            .as_str()
            .unwrap_or("no reason");
        return Err(anyhow!(
            "YouTube returned status={}: {}",
            playability,
            reason
        ));
    }

    let formats = data["streamingData"]["adaptiveFormats"]
        .as_array()
        .or_else(|| data["streamingData"]["formats"].as_array())
        .ok_or_else(|| anyhow!("No formats array in response"))?;

    let mut audio_formats: Vec<&serde_json::Value> = formats
        .iter()
        .filter(|f| {
            f["mimeType"]
                .as_str()
                .map(|m| m.starts_with("audio/"))
                .unwrap_or(false)
        })
        .collect();

    audio_formats.sort_by(|a, b| {
        let ab = a["bitrate"].as_u64().unwrap_or(0);
        let bb = b["bitrate"].as_u64().unwrap_or(0);
        bb.cmp(&ab)
    });

    let best = audio_formats
        .first()
        .ok_or_else(|| anyhow!("No audio-only formats found"))?;

    let url = best["url"]
        .as_str()
        .ok_or_else(|| anyhow!("Audio format has no URL"))?
        .to_string();

    let content_length = best["contentLength"].as_u64().unwrap_or(0);
    let mime_type = best["mimeType"].as_str().unwrap_or("").to_string();

    Ok(Output {
        url,
        content_length,
        mime_type,
    })
}
