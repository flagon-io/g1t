//! Responses signed by signxml, and one canonicalized by libxml2 itself
//! with inclusive prefixes (saml_fixtures.json), so canonicalization and
//! signatures are checked against implementations other than g1t's.

use super::*;
use serde_json::Value;

const ACS: &str = "https://g1t.sh/auth/sso/acme/saml";
const AUDIENCE: &str = "https://g1t.sh/auth/sso/acme/metadata";
const IDP: &str = "http://idp.example.test/entity";
/// 2026-10-17T08:01:00Z, a minute into the fixtures' five.
const NOW: u64 = 1_792_224_060_000;

fn fixtures() -> Value {
    serde_json::from_str(include_str!("saml_fixtures.json")).unwrap()
}

fn certs(field: &str) -> Vec<Vec<u8>> {
    certificates_from(fixtures()[field].as_str().unwrap()).unwrap()
}

fn expect<'a>(certificates: &'a [Vec<u8>]) -> Expect<'a> {
    Expect { idp_entity_id: IDP, certificates, acs_url: ACS, audience: AUDIENCE, request_id: "_req1", now_ms: NOW }
}

fn response(field: &str) -> String {
    fixtures()[field].as_str().unwrap().to_owned()
}

/// The fixture's XML changed by `edit`, encoded again.
fn edited(field: &str, edit: impl Fn(String) -> String) -> String {
    let xml = String::from_utf8(STANDARD.decode(response(field)).unwrap()).unwrap();
    STANDARD.encode(edit(xml))
}

#[test]
fn the_clock_in_these_tests_is_right() {
    assert_eq!(rfc3339(NOW), "2026-10-17T08:01:00.000Z");
}

#[test]
fn canonicalizes_as_libxml2_does() {
    for vector in fixtures()["c14n"].as_array().unwrap() {
        let xml = vector["xml"].as_str().unwrap();
        let prefixes: Vec<String> = vector["prefixes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p.as_str().unwrap())
            .map(|p| if p == "#default" { String::new() } else { p.to_owned() })
            .collect();
        let doc = Document::parse(xml).unwrap();
        let root = doc.root_element();
        assert_eq!(canonicalize(xml, root, None, &prefixes, false), vector["apex"].as_str().unwrap(), "{xml}");
        let first = root.first_element_child().unwrap();
        assert_eq!(canonicalize(xml, first, None, &prefixes, false), vector["child"].as_str().unwrap(), "{xml}");
    }
}

#[test]
fn a_signed_assertion_names_who_signed_in() {
    let certificates = certs("cert");
    for field in ["assertion_signed", "response_signed", "inclusive_signed"] {
        let asserted = verify_response(&response(field), &expect(&certificates)).unwrap_or_else(|e| panic!("{field}: {e}"));
        assert_eq!(asserted, Asserted { subject: "ada@acme.test".into(), email: Some("ada@acme.test".into()) }, "{field}");
    }
    assert_eq!(in_response_to(&response("assertion_signed")).as_deref(), Some("_req1"));
}

#[test]
fn another_certificate_is_refused() {
    let other = certs("other_cert");
    let refused = verify_response(&response("assertion_signed"), &expect(&other)).unwrap_err();
    assert_eq!(refused, BAD_SIGNATURE);
    // Rotation: the new and the old together.
    let mut both = other.clone();
    both.extend(certs("cert"));
    assert!(verify_response(&response("assertion_signed"), &expect(&both)).is_ok());
}

#[test]
fn a_changed_assertion_is_refused() {
    let certificates = certs("cert");
    for field in ["assertion_signed", "response_signed", "inclusive_signed"] {
        let changed = edited(field, |xml| xml.replace(">ada@acme.test<", ">eve@acme.test<"));
        let refused = verify_response(&changed, &expect(&certificates)).unwrap_err();
        assert!(refused.contains("changed after it was signed"), "{field}: {refused}");
    }
}

#[test]
fn an_unsigned_response_is_refused() {
    let certificates = certs("cert");
    let unsigned = edited("assertion_signed", |xml| {
        let start = xml.find("<ds:Signature").unwrap();
        let end = xml.find("</ds:Signature>").unwrap() + "</ds:Signature>".len();
        format!("{}{}", &xml[..start], &xml[end..])
    });
    assert_eq!(verify_response(&unsigned, &expect(&certificates)).unwrap_err(), NOT_SIGNED);
}

#[test]
fn a_second_assertion_cannot_ride_along() {
    let certificates = certs("cert");
    // Signature wrapping: an unsigned assertion beside the signed one.
    let wrapped = edited("response_signed", |xml| {
        xml.replacen(
            "<saml2:Assertion ",
            "<saml2:Assertion ID=\"_evil\" Version=\"2.0\"><saml2:Issuer>http://idp.example.test/entity</saml2:Issuer></saml2:Assertion><saml2:Assertion ",
            1,
        )
    });
    assert!(verify_response(&wrapped, &expect(&certificates)).unwrap_err().contains("more than one Assertion"));
    // An id used twice.
    let twice = edited("assertion_signed", |xml| {
        xml.replacen("<saml2p:Status>", "<saml2p:Extensions><x ID=\"_assert1\"/></saml2p:Extensions><saml2p:Status>", 1)
    });
    assert!(verify_response(&twice, &expect(&certificates)).unwrap_err().contains("uses an id twice"));
}

#[test]
fn it_must_be_for_this_sign_in() {
    let certificates = certs("cert");
    let signed = response("assertion_signed");
    let mut other = expect(&certificates);
    other.request_id = "_req2";
    assert!(verify_response(&signed, &other).unwrap_err().contains("answers another sign-in"));
    let mut other = expect(&certificates);
    other.audience = "https://g1t.sh/auth/sso/globex/metadata";
    assert!(verify_response(&signed, &other).unwrap_err().contains("not for g1t"));
    let mut other = expect(&certificates);
    other.acs_url = "https://g1t.sh/auth/sso/globex/saml";
    assert!(verify_response(&signed, &other).unwrap_err().contains("assertion consumer service"));
    let mut other = expect(&certificates);
    other.idp_entity_id = "http://someone.else/entity";
    assert!(verify_response(&signed, &other).unwrap_err().contains("issued by"));
    let mut later = expect(&certificates);
    later.now_ms = NOW + 10 * 60 * 1000;
    assert!(verify_response(&signed, &later).unwrap_err().contains("expired"));
    let mut earlier = expect(&certificates);
    earlier.now_ms = NOW - 10 * 60 * 1000;
    assert!(verify_response(&signed, &earlier).unwrap_err().contains("not valid yet"));
}

#[test]
fn a_provider_started_sign_in_is_refused() {
    let certificates = certs("cert");
    // Unsigned at the response level, so the edit leaves the signature good.
    let unasked = edited("assertion_signed", |xml| xml.replacen(" InResponseTo=\"_req1\"", "", 1));
    assert!(verify_response(&unasked, &expect(&certificates)).unwrap_err().contains("Start single sign-on from g1t"));
}

#[test]
fn no_dtd_is_read() {
    let certificates = certs("cert");
    let xml = "<!DOCTYPE r [<!ENTITY a \"aaaa\">]><samlp:Response xmlns:samlp=\"urn:oasis:names:tc:SAML:2.0:protocol\">&a;</samlp:Response>";
    assert!(verify_response(&STANDARD.encode(xml), &expect(&certificates)).unwrap_err().contains("not valid XML"));
}

#[test]
fn certificates_are_read_as_pasted() {
    let pem = fixtures()["cert"].as_str().unwrap().to_owned();
    let one = certificates_from(&pem).unwrap();
    assert_eq!(one.len(), 1);
    // Bare base64, as some providers download it.
    let bare: String = pem.lines().filter(|line| !line.starts_with("-----")).collect();
    assert_eq!(certificates_from(&bare).unwrap(), one);
    assert_eq!(certificates_from(&format!("{pem}\n{pem}")).unwrap().len(), 2);
    assert!(certificates_from("").is_err());
    assert!(certificates_from("-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----").is_err());
    assert_eq!(fingerprint(&one[0]).len(), 32 * 3 - 1);
}

#[test]
fn the_request_is_deflated_onto_the_sign_in_url() {
    let url = authn_request_url("https://idp.example.test/sso?app=1", "_abc", AUDIENCE, ACS, "state", NOW).unwrap();
    let parsed = worker::Url::parse(&url).unwrap();
    let pairs: std::collections::HashMap<String, String> = parsed.query_pairs().into_owned().collect();
    assert_eq!(pairs["app"], "1");
    assert_eq!(pairs["RelayState"], "state");
    let inflated = miniz_oxide::inflate::decompress_to_vec(&STANDARD.decode(&pairs["SAMLRequest"]).unwrap()).unwrap();
    let request = String::from_utf8(inflated).unwrap();
    assert!(request.contains("ID=\"_abc\""));
    assert!(request.contains("IssueInstant=\"2026-10-17T08:01:00Z\""));
    assert!(request.contains(&format!("AssertionConsumerServiceURL=\"{ACS}\"")));
    assert!(request.contains(&format!("<saml:Issuer>{AUDIENCE}</saml:Issuer>")));
    assert!(authn_request_url("http://idp.example.test/sso", "_abc", AUDIENCE, ACS, "s", NOW).is_none());
}

#[test]
fn metadata_names_the_assertion_consumer_service() {
    let xml = metadata(AUDIENCE, ACS);
    let doc = Document::parse(&xml).unwrap();
    assert_eq!(doc.root_element().attribute("entityID"), Some(AUDIENCE));
    assert!(xml.contains(&format!("Location=\"{ACS}\"")));
}

#[test]
fn a_comment_cannot_shorten_what_was_signed() {
    let certificates = certs("cert");
    // The CVE-2017-11427 trick: the digest skips the comment, the reader
    // would stop at it.
    let injected = edited("assertion_signed", |xml| xml.replacen(">ada@acme.test<", ">ada@acme.test<!---->.evil.io<", 1));
    assert!(verify_response(&injected, &expect(&certificates)).unwrap_err().contains("comments"));
    let pi = edited("assertion_signed", |xml| xml.replacen("<saml2:Subject>", "<?x y?><saml2:Subject>", 1));
    assert!(verify_response(&pi, &expect(&certificates)).unwrap_err().contains("processing instructions"));
}

#[test]
fn text_is_read_whole() {
    let xml = "<a>one<b>two</b> three</a>";
    let doc = Document::parse(xml).unwrap();
    assert_eq!(text(doc.root_element()), "onetwo three");
}

#[test]
fn deep_nesting_is_refused_before_canonicalization() {
    let certificates = certs("cert");
    let deep = format!(
        "<samlp:Response xmlns:samlp=\"{PROTOCOL}\">{}{}</samlp:Response>",
        "<x>".repeat(100),
        "</x>".repeat(100)
    );
    assert!(verify_response(&STANDARD.encode(deep), &expect(&certificates)).unwrap_err().contains("nests too deeply"));
}
