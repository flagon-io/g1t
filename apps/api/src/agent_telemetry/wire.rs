//! OTLP/HTTP requests read into the little of them g1t looks at: each
//! resource's attributes, and its log records or metric data points with
//! theirs. Both encodings: protobuf (`application/x-protobuf`), read field
//! by field from opentelemetry-proto's numbers, and JSON
//! (`application/json`, lowerCamelCase keys, 64-bit integers as strings or
//! numbers). Anything else in a request is skipped as it is read: span
//! data, exemplars, arrays and maps in attributes, bytes.
//!
//! https://opentelemetry.io/docs/specs/otlp/ and
//! https://github.com/open-telemetry/opentelemetry-proto (logs/v1,
//! metrics/v1, common/v1, collector/*/v1).

use serde_json::Value as Json;

/// An attribute's value, as far as g1t reads one.
#[derive(Clone, Debug, PartialEq)]
pub enum AnyValue {
    Str(String),
    Int(i64),
    Double(f64),
    Bool(bool),
    /// An array, a map or bytes: never read.
    Other,
}

impl AnyValue {
    /// As text: a string, or a number or bool written out.
    pub fn text(&self) -> Option<String> {
        match self {
            AnyValue::Str(text) => Some(text.clone()),
            AnyValue::Int(n) => Some(n.to_string()),
            AnyValue::Double(n) => Some(n.to_string()),
            AnyValue::Bool(b) => Some(b.to_string()),
            AnyValue::Other => None,
        }
    }

    /// As a number: a number, or a string that is one (harnesses send
    /// counts both ways).
    pub fn number(&self) -> Option<f64> {
        match self {
            AnyValue::Int(n) => Some(*n as f64),
            AnyValue::Double(n) => Some(*n),
            AnyValue::Str(text) => text.trim().parse::<f64>().ok(),
            _ => None,
        }
        .filter(|n| n.is_finite())
    }
}

pub type Attributes = Vec<(String, AnyValue)>;

/// The value of attribute `key`, if given.
pub fn attribute<'a>(attributes: &'a Attributes, key: &str) -> Option<&'a AnyValue> {
    attributes.iter().find(|(name, _)| name == key).map(|(_, value)| value)
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct LogRecord {
    pub time_unix_nano: u64,
    pub observed_time_unix_nano: u64,
    /// `LogRecord.event_name`, when the exporter sets it.
    pub event_name: String,
    /// The body when it is a short string: some harnesses name the event
    /// there. Read only to name the event, never kept.
    pub body_name: Option<String>,
    pub attributes: Attributes,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ResourceLogs {
    pub resource: Attributes,
    pub records: Vec<LogRecord>,
}

/// Whether a sum's or histogram's points are each a running total.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Temporality {
    #[default]
    Delta,
    Cumulative,
}

impl Temporality {
    fn of(value: i64) -> Temporality {
        if value == 2 { Temporality::Cumulative } else { Temporality::Delta }
    }
}

/// One data point: a sum's value, or a histogram's sum.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Point {
    pub time_unix_nano: u64,
    pub value: f64,
    pub attributes: Attributes,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Metric {
    pub name: String,
    /// A sum's or a histogram's; a gauge's are not read.
    pub points: Vec<Point>,
    pub temporality: Temporality,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ResourceMetrics {
    pub resource: Attributes,
    pub metrics: Vec<Metric>,
}

/// The longest body read to name an event.
const MAX_BODY_NAME: usize = 64;

// --- Protobuf ---

/// A protobuf message being read.
struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

/// One field of a message: its number and its value.
enum Field<'a> {
    Varint(u64),
    Fixed64(u64),
    Bytes(&'a [u8]),
    Fixed32,
}

const DAMAGED: &str = "The protobuf body could not be read.";

impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Reader { bytes, at: 0 }
    }

    fn varint(&mut self) -> Result<u64, String> {
        let mut value = 0u64;
        for shift in (0..64).step_by(7) {
            let byte = *self.bytes.get(self.at).ok_or(DAMAGED)?;
            self.at += 1;
            value |= u64::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                return Ok(value);
            }
        }
        Err(DAMAGED.to_owned())
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        let end = self.at.checked_add(n).filter(|end| *end <= self.bytes.len()).ok_or(DAMAGED)?;
        let taken = &self.bytes[self.at..end];
        self.at = end;
        Ok(taken)
    }

    /// The next field, or none at the end of the message.
    fn next(&mut self) -> Result<Option<(u64, Field<'a>)>, String> {
        if self.at >= self.bytes.len() {
            return Ok(None);
        }
        let key = self.varint()?;
        let field = match key & 7 {
            0 => Field::Varint(self.varint()?),
            1 => Field::Fixed64(u64::from_le_bytes(self.take(8)?.try_into().map_err(|_| DAMAGED)?)),
            2 => {
                let length = usize::try_from(self.varint()?).map_err(|_| DAMAGED)?;
                Field::Bytes(self.take(length)?)
            }
            5 => {
                self.take(4)?;
                Field::Fixed32
            }
            _ => return Err(DAMAGED.to_owned()),
        };
        Ok(Some((key >> 3, field)))
    }
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// `common.v1.AnyValue`.
fn any_value(bytes: &[u8]) -> Result<AnyValue, String> {
    let mut reader = Reader::new(bytes);
    let mut value = AnyValue::Other;
    while let Some((number, field)) = reader.next()? {
        value = match (number, field) {
            (1, Field::Bytes(bytes)) => AnyValue::Str(text(bytes)),
            (2, Field::Varint(n)) => AnyValue::Bool(n != 0),
            (3, Field::Varint(n)) => AnyValue::Int(n as i64),
            (4, Field::Fixed64(bits)) => AnyValue::Double(f64::from_bits(bits)),
            (5..=7, _) => AnyValue::Other,
            _ => continue,
        };
    }
    Ok(value)
}

/// `common.v1.KeyValue`.
fn key_value(bytes: &[u8]) -> Result<(String, AnyValue), String> {
    let mut reader = Reader::new(bytes);
    let (mut key, mut value) = (String::new(), AnyValue::Other);
    while let Some((number, field)) = reader.next()? {
        match (number, field) {
            (1, Field::Bytes(bytes)) => key = text(bytes),
            (2, Field::Bytes(bytes)) => value = any_value(bytes)?,
            _ => {}
        }
    }
    Ok((key, value))
}

/// `resource.v1.Resource`: its attributes.
fn resource(bytes: &[u8]) -> Result<Attributes, String> {
    let mut reader = Reader::new(bytes);
    let mut attributes = Vec::new();
    while let Some((number, field)) = reader.next()? {
        if let (1, Field::Bytes(bytes)) = (number, field) {
            attributes.push(key_value(bytes)?);
        }
    }
    Ok(attributes)
}

/// `logs.v1.LogRecord`.
fn log_record(bytes: &[u8]) -> Result<LogRecord, String> {
    let mut reader = Reader::new(bytes);
    let mut record = LogRecord::default();
    while let Some((number, field)) = reader.next()? {
        match (number, field) {
            (1, Field::Fixed64(n)) => record.time_unix_nano = n,
            (11, Field::Fixed64(n)) => record.observed_time_unix_nano = n,
            (5, Field::Bytes(bytes)) => {
                if let AnyValue::Str(body) = any_value(bytes)? {
                    record.body_name = short(body);
                }
            }
            (6, Field::Bytes(bytes)) => record.attributes.push(key_value(bytes)?),
            (12, Field::Bytes(bytes)) => record.event_name = text(bytes),
            _ => {}
        }
    }
    Ok(record)
}

/// A body short enough, and plain enough, to be an event's name.
fn short(body: String) -> Option<String> {
    (body.len() <= MAX_BODY_NAME && !body.contains(char::is_whitespace)).then_some(body)
}

/// `collector.logs.v1.ExportLogsServiceRequest`.
pub fn logs_from_protobuf(bytes: &[u8]) -> Result<Vec<ResourceLogs>, String> {
    let mut out = Vec::new();
    let mut request = Reader::new(bytes);
    while let Some((number, field)) = request.next()? {
        let (1, Field::Bytes(resource_logs)) = (number, field) else { continue };
        let mut one = ResourceLogs::default();
        let mut reader = Reader::new(resource_logs);
        while let Some((number, field)) = reader.next()? {
            match (number, field) {
                (1, Field::Bytes(bytes)) => one.resource = resource(bytes)?,
                (2, Field::Bytes(scope_logs)) => {
                    let mut scope = Reader::new(scope_logs);
                    while let Some((number, field)) = scope.next()? {
                        if let (2, Field::Bytes(bytes)) = (number, field) {
                            one.records.push(log_record(bytes)?);
                        }
                    }
                }
                _ => {}
            }
        }
        out.push(one);
    }
    Ok(out)
}

/// `metrics.v1.NumberDataPoint` (`histogram`: a `HistogramDataPoint`,
/// whose sum is the value).
fn point(bytes: &[u8], histogram: bool) -> Result<Point, String> {
    let mut reader = Reader::new(bytes);
    let mut point = Point::default();
    while let Some((number, field)) = reader.next()? {
        match (histogram, number, field) {
            (_, 3, Field::Fixed64(n)) => point.time_unix_nano = n,
            (false, 4, Field::Fixed64(bits)) => point.value = f64::from_bits(bits),
            (false, 6, Field::Fixed64(n)) => point.value = n as i64 as f64,
            (false, 7, Field::Bytes(bytes)) => point.attributes.push(key_value(bytes)?),
            (true, 5, Field::Fixed64(bits)) => point.value = f64::from_bits(bits),
            (true, 9, Field::Bytes(bytes)) => point.attributes.push(key_value(bytes)?),
            _ => {}
        }
    }
    Ok(point)
}

/// A `Sum` or `Histogram`: its points and temporality.
fn points(bytes: &[u8], histogram: bool) -> Result<(Vec<Point>, Temporality), String> {
    let mut reader = Reader::new(bytes);
    let (mut points, mut temporality) = (Vec::new(), Temporality::Delta);
    while let Some((number, field)) = reader.next()? {
        match (number, field) {
            (1, Field::Bytes(bytes)) => points.push(point(bytes, histogram)?),
            (2, Field::Varint(n)) => temporality = Temporality::of(n as i64),
            _ => {}
        }
    }
    Ok((points, temporality))
}

/// `metrics.v1.Metric`: a sum's or a histogram's; any other kind has no points.
fn metric(bytes: &[u8]) -> Result<Metric, String> {
    let mut reader = Reader::new(bytes);
    let mut metric = Metric::default();
    while let Some((number, field)) = reader.next()? {
        match (number, field) {
            (1, Field::Bytes(bytes)) => metric.name = text(bytes),
            (7, Field::Bytes(bytes)) => (metric.points, metric.temporality) = points(bytes, false)?,
            (9, Field::Bytes(bytes)) => (metric.points, metric.temporality) = points(bytes, true)?,
            _ => {}
        }
    }
    Ok(metric)
}

/// `collector.metrics.v1.ExportMetricsServiceRequest`.
pub fn metrics_from_protobuf(bytes: &[u8]) -> Result<Vec<ResourceMetrics>, String> {
    let mut out = Vec::new();
    let mut request = Reader::new(bytes);
    while let Some((number, field)) = request.next()? {
        let (1, Field::Bytes(resource_metrics)) = (number, field) else { continue };
        let mut one = ResourceMetrics::default();
        let mut reader = Reader::new(resource_metrics);
        while let Some((number, field)) = reader.next()? {
            match (number, field) {
                (1, Field::Bytes(bytes)) => one.resource = resource(bytes)?,
                (2, Field::Bytes(scope_metrics)) => {
                    let mut scope = Reader::new(scope_metrics);
                    while let Some((number, field)) = scope.next()? {
                        if let (2, Field::Bytes(bytes)) = (number, field) {
                            one.metrics.push(metric(bytes)?);
                        }
                    }
                }
                _ => {}
            }
        }
        out.push(one);
    }
    Ok(out)
}

/// Encodes an export's answer: empty for everything accepted, else its
/// `partial_success` (field 1) with how many were rejected (1) and why (2).
pub fn partial_success_protobuf(rejected: u64, message: &str) -> Vec<u8> {
    if rejected == 0 && message.is_empty() {
        return Vec::new();
    }
    let mut inner = Vec::new();
    if rejected > 0 {
        inner.push(1 << 3);
        varint(&mut inner, rejected);
    }
    if !message.is_empty() {
        inner.push((2 << 3) | 2);
        varint(&mut inner, message.len() as u64);
        inner.extend_from_slice(message.as_bytes());
    }
    let mut out = vec![(1 << 3) | 2];
    varint(&mut out, inner.len() as u64);
    out.extend(inner);
    out
}

/// Encodes a `google.rpc.Status`: its code (1) and message (2).
pub fn status_protobuf(code: u64, message: &str) -> Vec<u8> {
    let mut out = vec![1 << 3];
    varint(&mut out, code);
    out.push((2 << 3) | 2);
    varint(&mut out, message.len() as u64);
    out.extend_from_slice(message.as_bytes());
    out
}

fn varint(out: &mut Vec<u8>, mut value: u64) {
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        if value == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

// --- JSON ---

/// A field by its lowerCamelCase name, or the proto's own snake_case one.
fn get<'a>(object: &'a Json, camel: &str, snake: &str) -> &'a Json {
    match object.get(camel) {
        Some(value) => value,
        None => object.get(snake).unwrap_or(&Json::Null),
    }
}

fn list<'a>(object: &'a Json, camel: &str, snake: &str) -> &'a [Json] {
    get(object, camel, snake).as_array().map(Vec::as_slice).unwrap_or_default()
}

/// A 64-bit integer, as a string or a number.
fn integer(value: &Json) -> Option<i64> {
    match value {
        Json::String(text) => text.trim().parse().ok(),
        Json::Number(n) => n.as_i64().or_else(|| n.as_u64().map(|n| n as i64)).or_else(|| n.as_f64().map(|n| n as i64)),
        _ => None,
    }
}

fn json_any(value: &Json) -> AnyValue {
    if let Some(text) = get(value, "stringValue", "string_value").as_str() {
        AnyValue::Str(text.to_owned())
    } else if let Some(b) = get(value, "boolValue", "bool_value").as_bool() {
        AnyValue::Bool(b)
    } else if let Some(n) = integer(get(value, "intValue", "int_value")) {
        AnyValue::Int(n)
    } else if let Some(n) = get(value, "doubleValue", "double_value").as_f64() {
        AnyValue::Double(n)
    } else {
        AnyValue::Other
    }
}

fn json_attributes(attributes: &[Json]) -> Attributes {
    attributes
        .iter()
        .filter_map(|pair| Some((pair.get("key")?.as_str()?.to_owned(), json_any(pair.get("value").unwrap_or(&Json::Null)))))
        .collect()
}

fn nanos(value: &Json) -> u64 {
    integer(value).and_then(|n| u64::try_from(n).ok()).unwrap_or(0)
}

fn json_body(bytes: &[u8]) -> Result<Json, String> {
    serde_json::from_slice(bytes).map_err(|_| "The JSON body could not be read.".to_owned())
}

/// An `ExportLogsServiceRequest` in JSON.
pub fn logs_from_json(bytes: &[u8]) -> Result<Vec<ResourceLogs>, String> {
    let request = json_body(bytes)?;
    Ok(list(&request, "resourceLogs", "resource_logs")
        .iter()
        .map(|resource_logs| ResourceLogs {
            resource: json_attributes(list(get(resource_logs, "resource", "resource"), "attributes", "attributes")),
            records: list(resource_logs, "scopeLogs", "scope_logs")
                .iter()
                .flat_map(|scope| list(scope, "logRecords", "log_records"))
                .map(|record| LogRecord {
                    time_unix_nano: nanos(get(record, "timeUnixNano", "time_unix_nano")),
                    observed_time_unix_nano: nanos(get(record, "observedTimeUnixNano", "observed_time_unix_nano")),
                    event_name: get(record, "eventName", "event_name").as_str().unwrap_or_default().to_owned(),
                    body_name: match json_any(get(record, "body", "body")) {
                        AnyValue::Str(body) => short(body),
                        _ => None,
                    },
                    attributes: json_attributes(list(record, "attributes", "attributes")),
                })
                .collect(),
        })
        .collect())
}

fn json_points(data: &Json, histogram: bool) -> Vec<Point> {
    list(data, "dataPoints", "data_points")
        .iter()
        .map(|point| Point {
            time_unix_nano: nanos(get(point, "timeUnixNano", "time_unix_nano")),
            value: if histogram {
                get(point, "sum", "sum").as_f64().unwrap_or(0.0)
            } else {
                get(point, "asDouble", "as_double")
                    .as_f64()
                    .or_else(|| integer(get(point, "asInt", "as_int")).map(|n| n as f64))
                    .unwrap_or(0.0)
            },
            attributes: json_attributes(list(point, "attributes", "attributes")),
        })
        .collect()
}

/// An `ExportMetricsServiceRequest` in JSON.
pub fn metrics_from_json(bytes: &[u8]) -> Result<Vec<ResourceMetrics>, String> {
    let request = json_body(bytes)?;
    Ok(list(&request, "resourceMetrics", "resource_metrics")
        .iter()
        .map(|resource_metrics| ResourceMetrics {
            resource: json_attributes(list(get(resource_metrics, "resource", "resource"), "attributes", "attributes")),
            metrics: list(resource_metrics, "scopeMetrics", "scope_metrics")
                .iter()
                .flat_map(|scope| list(scope, "metrics", "metrics"))
                .map(|metric| {
                    let name = get(metric, "name", "name").as_str().unwrap_or_default().to_owned();
                    let (data, histogram) = match (metric.get("sum"), metric.get("histogram")) {
                        (Some(sum), _) => (sum, false),
                        (None, Some(histogram)) => (histogram, true),
                        _ => return Metric { name, ..Metric::default() },
                    };
                    Metric {
                        name,
                        points: json_points(data, histogram),
                        temporality: Temporality::of(integer(get(data, "aggregationTemporality", "aggregation_temporality")).unwrap_or(1)),
                    }
                })
                .collect(),
        })
        .collect())
}

#[cfg(test)]
pub(crate) mod encode {
    //! Protobuf written field by field, for testing the reader against
    //! what an exporter sends.
    use super::varint;

    pub fn bytes(number: u64, value: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        varint(&mut out, (number << 3) | 2);
        varint(&mut out, value.len() as u64);
        out.extend_from_slice(value);
        out
    }

    pub fn fixed64(number: u64, value: u64) -> Vec<u8> {
        let mut out = Vec::new();
        varint(&mut out, (number << 3) | 1);
        out.extend_from_slice(&value.to_le_bytes());
        out
    }

    pub fn uint(number: u64, value: u64) -> Vec<u8> {
        let mut out = Vec::new();
        varint(&mut out, number << 3);
        varint(&mut out, value);
        out
    }

    pub fn string_attribute(key: &str, value: &str) -> Vec<u8> {
        [bytes(1, key.as_bytes()), bytes(2, &bytes(1, value.as_bytes()))].concat()
    }

    pub fn int_attribute(key: &str, value: i64) -> Vec<u8> {
        [bytes(1, key.as_bytes()), bytes(2, &uint(3, value as u64))].concat()
    }

    pub fn double_attribute(key: &str, value: f64) -> Vec<u8> {
        [bytes(1, key.as_bytes()), bytes(2, &fixed64(4, value.to_bits()))].concat()
    }
}

#[cfg(test)]
mod tests {
    use super::encode::*;
    use super::*;

    #[test]
    fn a_protobuf_log_record_reads_with_its_attributes() {
        let record = [
            fixed64(1, 1_791_800_000_000_000_000),
            bytes(5, &bytes(1, b"claude_code.api_request")),
            bytes(6, &string_attribute("session.id", "abc")),
            bytes(6, &int_attribute("input_tokens", 12)),
            bytes(6, &double_attribute("cost_usd", 0.25)),
            // An array value is skipped.
            bytes(6, &[bytes(1, b"list"), bytes(2, &bytes(5, &[]))].concat()),
            bytes(12, b"api_request"),
        ]
        .concat();
        let scope = [bytes(1, &bytes(1, b"com.anthropic.claude_code")), bytes(2, &record)].concat();
        let resource = bytes(1, &string_attribute("service.name", "claude-code"));
        let request = bytes(1, &[bytes(1, &resource), bytes(2, &scope)].concat());
        let read = logs_from_protobuf(&request).unwrap();
        assert_eq!(read.len(), 1);
        assert_eq!(read[0].resource, vec![("service.name".to_owned(), AnyValue::Str("claude-code".into()))]);
        let record = &read[0].records[0];
        assert_eq!(record.time_unix_nano, 1_791_800_000_000_000_000);
        assert_eq!(record.event_name, "api_request");
        assert_eq!(record.body_name.as_deref(), Some("claude_code.api_request"));
        assert_eq!(attribute(&record.attributes, "input_tokens"), Some(&AnyValue::Int(12)));
        assert_eq!(attribute(&record.attributes, "cost_usd"), Some(&AnyValue::Double(0.25)));
        assert_eq!(attribute(&record.attributes, "list"), Some(&AnyValue::Other));
    }

    #[test]
    fn protobuf_metrics_read_sums_and_histograms() {
        let sum_point = [fixed64(3, 5), fixed64(4, 1.5f64.to_bits()), bytes(7, &string_attribute("type", "input"))].concat();
        let int_point = [fixed64(6, 40), bytes(7, &string_attribute("type", "output"))].concat();
        let sum = [bytes(1, &sum_point), bytes(1, &int_point), uint(2, 2), uint(3, 1)].concat();
        let histogram_point =
            [uint(4, 3), fixed64(5, 900.0f64.to_bits()), bytes(9, &string_attribute("gen_ai.token.type", "input"))].concat();
        let histogram = [bytes(1, &histogram_point), uint(2, 1)].concat();
        let metrics = [
            bytes(2, &[bytes(1, b"claude_code.token.usage"), bytes(7, &sum)].concat()),
            bytes(2, &[bytes(1, b"gen_ai.client.token.usage"), bytes(9, &histogram)].concat()),
            // A gauge: no points.
            bytes(2, &[bytes(1, b"gauge"), bytes(5, &[])].concat()),
        ]
        .concat();
        let request = bytes(1, &bytes(2, &metrics));
        let read = metrics_from_protobuf(&request).unwrap();
        let metrics = &read[0].metrics;
        assert_eq!(metrics[0].temporality, Temporality::Cumulative);
        assert_eq!(metrics[0].points.iter().map(|point| point.value).collect::<Vec<_>>(), vec![1.5, 40.0]);
        assert_eq!(metrics[1].temporality, Temporality::Delta);
        assert_eq!(metrics[1].points[0].value, 900.0);
        assert!(metrics[2].points.is_empty());
    }

    #[test]
    fn a_damaged_protobuf_body_is_refused() {
        assert!(logs_from_protobuf(&[0x0a, 0x05, 0x01]).is_err());
        assert!(logs_from_protobuf(&[0x0b]).is_err(), "a group");
        assert_eq!(logs_from_protobuf(&[]).unwrap(), vec![]);
    }

    #[test]
    fn json_takes_integers_as_strings_or_numbers_and_either_spelling() {
        let request = serde_json::json!({
            "resource_logs": [{
                "resource": { "attributes": [{ "key": "service.name", "value": { "stringValue": "gemini-cli" } }] },
                "scopeLogs": [{ "logRecords": [{
                    "timeUnixNano": "1791800000000000000",
                    "body": { "stringValue": "API response from gemini-3-pro. Status: 200" },
                    "attributes": [
                        { "key": "input_token_count", "value": { "intValue": "120" } },
                        { "key": "output_token_count", "value": { "intValue": 7 } },
                        { "key": "flag", "value": { "boolValue": true } }
                    ]
                }] }]
            }]
        });
        let read = logs_from_json(request.to_string().as_bytes()).unwrap();
        let record = &read[0].records[0];
        assert_eq!(record.time_unix_nano, 1_791_800_000_000_000_000);
        assert_eq!(record.body_name, None, "a sentence is no event name");
        assert_eq!(attribute(&record.attributes, "input_token_count").and_then(AnyValue::number), Some(120.0));
        assert_eq!(attribute(&record.attributes, "output_token_count").and_then(AnyValue::number), Some(7.0));
        assert!(logs_from_json(b"{").is_err());
    }

    #[test]
    fn answers_encode_as_the_spec_has_them() {
        assert!(partial_success_protobuf(0, "").is_empty());
        // partial_success { rejected_log_records: 2, error_message: "no" }
        assert_eq!(partial_success_protobuf(2, "no"), vec![0x0a, 0x06, 0x08, 0x02, 0x12, 0x02, b'n', b'o']);
        assert_eq!(status_protobuf(3, "x"), vec![0x08, 0x03, 0x12, 0x01, b'x']);
    }
}
