//! SAML 2.0 for single sign-on: the request g1t sends (HTTP-Redirect
//! binding), the metadata it publishes, and checking the response the
//! provider posts back (HTTP-POST binding).
//!
//! A response is believed only when its signature verifies under one of
//! the certificates the workspace's owner pasted in, and only the signed
//! element is read: the one assertion, signed itself or inside a signed
//! response. The checks follow the SAML profile and XML Signature, kept
//! deliberately narrow so nothing unusual gets through:
//!
//! - **Signed by the provider.** One `Reference`, to its own parent by
//!   `ID`; transforms only enveloped-signature and exclusive
//!   canonicalization; RSA with SHA-256, -384 or -512 (never SHA-1). IDs
//!   must be unique in the document, so no second element can stand in for
//!   the signed one, and no DTD is read at all.
//! - **For this sign-in.** `InResponseTo` names the request g1t sent (its
//!   state row is spent on use, so a response replays nowhere), the
//!   destination and recipient are g1t's assertion consumer service, the
//!   audience is g1t's entity id, the issuer is the provider's, and the
//!   times hold, give or take three minutes.
//! - **Not encrypted.** An encrypted assertion is refused with how to turn
//!   it off: the response arrives over TLS straight from the browser.
//!
//! Provider-started sign-ins (no `InResponseTo`) are refused: they could
//! sign a person in to a session that never asked.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use g1t_contracts::time::{parse_rfc3339, rfc3339};
use roxmltree::{Document, Node, NodeId, NodeType, ParsingOptions};
use rsa::pkcs8::DecodePublicKey;
use rsa::{Pkcs1v15Sign, RsaPublicKey};
use sha2::{Digest, Sha256, Sha384, Sha512};

pub const PROTOCOL: &str = "urn:oasis:names:tc:SAML:2.0:protocol";
pub const ASSERTION: &str = "urn:oasis:names:tc:SAML:2.0:assertion";
const METADATA: &str = "urn:oasis:names:tc:SAML:2.0:metadata";
const DSIG: &str = "http://www.w3.org/2000/09/xmldsig#";
const EXC_C14N: &str = "http://www.w3.org/2001/10/xml-exc-c14n#";
const EXC_C14N_COMMENTS: &str = "http://www.w3.org/2001/10/xml-exc-c14n#WithComments";
const ENVELOPED: &str = "http://www.w3.org/2000/09/xmldsig#enveloped-signature";
const SUCCESS: &str = "urn:oasis:names:tc:SAML:2.0:status:Success";
const BEARER: &str = "urn:oasis:names:tc:SAML:2.0:cm:bearer";
const POST_BINDING: &str = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST";
const EMAIL_FORMAT: &str = "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress";
const UNSPECIFIED_FORMAT: &str = "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified";
const TRANSIENT_FORMAT: &str = "urn:oasis:names:tc:SAML:2.0:nameid-format:transient";
/// How far apart g1t's clock and the provider's may be.
const SKEW_MS: u64 = 3 * 60 * 1000;
/// Bigger than any real response.
const MAX_RESPONSE_BYTES: usize = 512 * 1024;
/// Attribute names providers use for the person's address.
const EMAIL_ATTRIBUTES: &[&str] = &[
    "email",
    "mail",
    "emailaddress",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
    "urn:oid:0.9.2342.19200300.100.1.3",
];

const NOT_SIGNED: &str = "The identity provider's response is not signed. Set it to sign the assertion or the response.";
const BAD_SIGNATURE: &str = "The identity provider's signature did not verify with the certificate saved for this workspace. Check that the certificate in the single sign-on settings is the provider's current signing certificate.";

/// What a response must match.
pub struct Expect<'a> {
    /// The provider's entity id: the issuer.
    pub idp_entity_id: &'a str,
    /// Its signing certificates, DER.
    pub certificates: &'a [Vec<u8>],
    /// g1t's assertion consumer service, exactly as sent.
    pub acs_url: &'a str,
    /// g1t's entity id: the audience.
    pub audience: &'a str,
    /// The id of the request g1t sent.
    pub request_id: &'a str,
    pub now_ms: u64,
}

/// Who the provider says signed in.
#[derive(Debug, PartialEq, Eq)]
pub struct Asserted {
    /// The NameID: the person's stable id at the provider.
    pub subject: String,
    pub email: Option<String>,
}

/// The `InResponseTo` of a posted response, to find its request by, before
/// anything is believed: nothing read here is trusted.
pub fn in_response_to(saml_response: &str) -> Option<String> {
    let xml = decode(saml_response).ok()?;
    let doc = parse(&xml).ok()?;
    doc.root_element().attribute("InResponseTo").map(str::to_owned)
}

fn decode(saml_response: &str) -> Result<String, String> {
    let compact: String = saml_response.chars().filter(|c| !c.is_whitespace()).collect();
    if compact.len() > MAX_RESPONSE_BYTES * 4 / 3 + 4 {
        return Err("The identity provider's response is too large.".to_owned());
    }
    let bytes = STANDARD.decode(compact).map_err(|_| "The identity provider's response could not be read.".to_owned())?;
    String::from_utf8(bytes).map_err(|_| "The identity provider's response could not be read.".to_owned())
}

fn parse(xml: &str) -> Result<Document<'_>, String> {
    // No DTD, ever: entities are how XML is made to lie.
    Document::parse_with_options(xml, ParsingOptions { allow_dtd: false, ..ParsingOptions::default() })
        .map_err(|_| "The identity provider's response is not valid XML.".to_owned())
}

/// Checks a posted `SAMLResponse` (base64) against `expect` and says who
/// signed in.
pub fn verify_response(saml_response: &str, expect: &Expect) -> Result<Asserted, String> {
    let xml = decode(saml_response)?;
    let doc = parse(&xml)?;
    let response = doc.root_element();
    if !response.has_tag_name((PROTOCOL, "Response")) {
        return Err("The identity provider did not send a SAML response.".to_owned());
    }
    unique_ids(&doc)?;
    plain(&doc)?;
    // Signed first: nothing else is read until it verifies.
    let assertion = only_child(response, ASSERTION, "Assertion")?;
    let Some(assertion) = assertion else {
        if child(response, ASSERTION, "EncryptedAssertion").is_some() {
            return Err("The identity provider encrypted the assertion. Turn off assertion encryption for g1t: the response reaches g1t over HTTPS.".to_owned());
        }
        return Err(status_message(response).unwrap_or_else(|| "The identity provider's response has no assertion.".to_owned()));
    };
    let mut assertion_signed = false;
    let mut response_signed = false;
    if let Some(signature) = only_child(assertion, DSIG, "Signature")? {
        verify_signature(&xml, signature, expect.certificates)?;
        assertion_signed = true;
    }
    if let Some(signature) = only_child(response, DSIG, "Signature")? {
        verify_signature(&xml, signature, expect.certificates)?;
        response_signed = true;
    }
    if !assertion_signed && !response_signed {
        return Err(NOT_SIGNED.to_owned());
    }
    if let Some(message) = status_message(response) {
        return Err(message);
    }
    check_response(response, assertion, expect, response_signed)
}

/// Why the provider said no, when its status is not success.
fn status_message(response: Node) -> Option<String> {
    let status = child(response, PROTOCOL, "Status")?;
    let code = child(status, PROTOCOL, "StatusCode")?.attribute("Value")?;
    if code == SUCCESS {
        return None;
    }
    let said = child(status, PROTOCOL, "StatusMessage").and_then(|m| m.text()).map(str::trim).filter(|m| !m.is_empty());
    Some(match said {
        Some(said) => format!("The identity provider refused the sign-in: {said}"),
        None => format!("The identity provider refused the sign-in ({}).", code.rsplit(':').next().unwrap_or(code)),
    })
}

/// `response_signed`: whether the response itself was signed. When only the
/// assertion is, the response's own `InResponseTo` is anyone's to write,
/// so the assertion's signed subject confirmation must name the request.
fn check_response(response: Node, assertion: Node, expect: &Expect, response_signed: bool) -> Result<Asserted, String> {
    match response.attribute("InResponseTo") {
        Some(id) if id == expect.request_id => {}
        Some(_) => return Err("This response answers another sign-in. Start again.".to_owned()),
        None => return Err("Start single sign-on from g1t: sign-ins started at the identity provider are not accepted.".to_owned()),
    }
    if let Some(destination) = response.attribute("Destination")
        && destination != expect.acs_url
    {
        return Err(format!("The response was sent to {destination}, not this workspace's assertion consumer service ({}).", expect.acs_url));
    }
    if let Some(issuer) = child(response, ASSERTION, "Issuer")
        && text(issuer) != expect.idp_entity_id
    {
        return Err(issuer_mismatch(&text(issuer), expect.idp_entity_id));
    }
    let issuer = child(assertion, ASSERTION, "Issuer").map(text).unwrap_or_default();
    if issuer != expect.idp_entity_id {
        return Err(issuer_mismatch(&issuer, expect.idp_entity_id));
    }
    let now = expect.now_ms;
    let conditions = child(assertion, ASSERTION, "Conditions");
    if let Some(conditions) = conditions {
        within(conditions.attribute("NotBefore"), conditions.attribute("NotOnOrAfter"), now)?;
    }
    let audiences: Vec<String> = conditions
        .into_iter()
        .flat_map(|c| children(c, ASSERTION, "AudienceRestriction"))
        .flat_map(|r| children(r, ASSERTION, "Audience"))
        .map(text)
        .collect();
    if !audiences.iter().any(|audience| audience == expect.audience) {
        return Err(format!("The assertion is not for g1t: set the provider's audience (SP entity id) to {}.", expect.audience));
    }
    let subject = child(assertion, ASSERTION, "Subject").ok_or("The assertion names no one.")?;
    let confirmed = children(subject, ASSERTION, "SubjectConfirmation")
        .filter(|c| c.attribute("Method") == Some(BEARER))
        .filter_map(|c| child(c, ASSERTION, "SubjectConfirmationData"))
        .any(|data| {
            data.attribute("Recipient") == Some(expect.acs_url)
                && match data.attribute("InResponseTo") {
                    Some(id) => id == expect.request_id,
                    None => response_signed,
                }
                && data.attribute("NotBefore").is_none()
                && data.attribute("NotOnOrAfter").and_then(parse_time).is_some_and(|at| now < at + SKEW_MS)
        });
    if !confirmed {
        return Err(format!(
            "The assertion's subject confirmation does not match: the recipient must be {} and it must not have expired.",
            expect.acs_url
        ));
    }
    let name_id = child(subject, ASSERTION, "NameID").ok_or("The assertion has no NameID.")?;
    if name_id.attribute("Format") == Some(TRANSIENT_FORMAT) {
        return Err("The identity provider sends a transient NameID, which changes every time. Set it to send a persistent one, or the email address.".to_owned());
    }
    let subject_id = text(name_id);
    if subject_id.is_empty() || subject_id.len() > 512 {
        return Err("The assertion's NameID is empty.".to_owned());
    }
    let email = attribute_email(assertion).or_else(|| {
        let format = name_id.attribute("Format").unwrap_or(UNSPECIFIED_FORMAT);
        (format == EMAIL_FORMAT || subject_id.contains('@')).then(|| subject_id.clone())
    });
    Ok(Asserted { subject: subject_id, email: email.map(|e| e.trim().to_lowercase()).filter(|e| e.contains('@')) })
}

fn issuer_mismatch(said: &str, expected: &str) -> String {
    format!("The response was issued by {said:?}, not the identity provider saved for this workspace ({expected:?}). Check the provider's entity id.")
}

fn attribute_email(assertion: Node) -> Option<String> {
    children(assertion, ASSERTION, "AttributeStatement")
        .flat_map(|s| children(s, ASSERTION, "Attribute"))
        .find(|a| a.attribute("Name").is_some_and(|name| EMAIL_ATTRIBUTES.iter().any(|known| known.eq_ignore_ascii_case(name))))
        .and_then(|a| child(a, ASSERTION, "AttributeValue"))
        .map(text)
        .filter(|value| !value.is_empty())
}

/// A SAML time: UTC, written with `Z`, `+00:00`, or no zone at all.
fn parse_time(at: &str) -> Option<u64> {
    let at = at.trim();
    let at = at.strip_suffix("+00:00").or_else(|| at.strip_suffix("-00:00")).unwrap_or(at);
    if at.ends_with('Z') {
        parse_rfc3339(at)
    } else {
        parse_rfc3339(&format!("{at}Z"))
    }
}

fn within(not_before: Option<&str>, not_on_or_after: Option<&str>, now: u64) -> Result<(), String> {
    if let Some(at) = not_before {
        let at = parse_time(at).ok_or("The assertion's times could not be read.")?;
        if now + SKEW_MS < at {
            return Err("The assertion is not valid yet: check the identity provider's clock.".to_owned());
        }
    }
    if let Some(at) = not_on_or_after {
        let at = parse_time(at).ok_or("The assertion's times could not be read.")?;
        if now >= at + SKEW_MS {
            return Err("The assertion has expired. Start again.".to_owned());
        }
    }
    Ok(())
}

// --- The document -----------------------------------------------------------

/// All of an element's text, as canonicalization reads it: every text node
/// inside it, not only the first, so what is read is what was signed.
fn text(node: Node) -> String {
    let all: String = node.descendants().filter(Node::is_text).filter_map(|t| t.text()).collect();
    all.trim().to_owned()
}

/// The deepest a response may nest. Real ones are under ten.
const MAX_DEPTH: usize = 64;

/// Refuses comments and processing instructions anywhere in the response,
/// and nesting deeper than any provider sends. Canonicalization leaves
/// comments out, so `ada@acme.test<!---->.evil.io` signs as one address and
/// would read as another; no provider puts them in a response. Depth is
/// checked before canonicalization, which recurses.
fn plain(doc: &Document) -> Result<(), String> {
    // Document order visits a parent before its children, so each depth is
    // its parent's plus one, found without recursion.
    let mut depths: std::collections::HashMap<NodeId, usize> = std::collections::HashMap::new();
    for node in doc.descendants() {
        if node.is_comment() || node.is_pi() {
            return Err("The identity provider's response holds comments or processing instructions, which g1t does not accept.".to_owned());
        }
        let depth = node.parent().and_then(|parent| depths.get(&parent.id()).copied()).unwrap_or(0) + 1;
        if depth > MAX_DEPTH {
            return Err("The identity provider's response nests too deeply.".to_owned());
        }
        depths.insert(node.id(), depth);
    }
    Ok(())
}

fn children<'a, 'i>(node: Node<'a, 'i>, ns: &'a str, name: &'a str) -> impl Iterator<Item = Node<'a, 'i>> + 'a {
    node.children().filter(move |c| c.is_element() && c.has_tag_name((ns, name)))
}

fn child<'a, 'i>(node: Node<'a, 'i>, ns: &'a str, name: &'a str) -> Option<Node<'a, 'i>> {
    children(node, ns, name).next()
}

/// The child named so, refusing more than one.
fn only_child<'a, 'i>(node: Node<'a, 'i>, ns: &'a str, name: &'a str) -> Result<Option<Node<'a, 'i>>, String> {
    let mut found = children(node, ns, name);
    let first = found.next();
    if found.next().is_some() {
        return Err(format!("The identity provider's response has more than one {name}."));
    }
    Ok(first)
}

/// Refuses a document where two elements share an `ID`: a signature names
/// what it signs by id, so the id must name one thing.
fn unique_ids(doc: &Document) -> Result<(), String> {
    let mut seen = std::collections::HashSet::new();
    for node in doc.descendants().filter(Node::is_element) {
        for attribute in node.attributes() {
            if attribute.namespace().is_none() && matches!(attribute.name(), "ID" | "Id" | "id") && !seen.insert(attribute.value()) {
                return Err("The identity provider's response uses an id twice.".to_owned());
            }
        }
    }
    Ok(())
}

// --- XML Signature ----------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Hash {
    Sha256,
    Sha384,
    Sha512,
}

impl Hash {
    fn digest_method(uri: &str) -> Result<Hash, String> {
        match uri {
            "http://www.w3.org/2001/04/xmlenc#sha256" => Ok(Hash::Sha256),
            "http://www.w3.org/2001/04/xmldsig-more#sha384" => Ok(Hash::Sha384),
            "http://www.w3.org/2001/04/xmlenc#sha512" => Ok(Hash::Sha512),
            "http://www.w3.org/2000/09/xmldsig#sha1" => Err(SHA1.to_owned()),
            other => Err(format!("The identity provider used a digest g1t does not accept ({other}).")),
        }
    }

    fn signature_method(uri: &str) -> Result<Hash, String> {
        match uri {
            "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256" => Ok(Hash::Sha256),
            "http://www.w3.org/2001/04/xmldsig-more#rsa-sha384" => Ok(Hash::Sha384),
            "http://www.w3.org/2001/04/xmldsig-more#rsa-sha512" => Ok(Hash::Sha512),
            "http://www.w3.org/2000/09/xmldsig#rsa-sha1" => Err(SHA1.to_owned()),
            other => Err(format!("The identity provider signed with an algorithm g1t does not accept ({other}). Use RSA with SHA-256.")),
        }
    }

    fn digest(self, data: &[u8]) -> Vec<u8> {
        match self {
            Hash::Sha256 => Sha256::digest(data).to_vec(),
            Hash::Sha384 => Sha384::digest(data).to_vec(),
            Hash::Sha512 => Sha512::digest(data).to_vec(),
        }
    }

    fn scheme(self) -> Pkcs1v15Sign {
        match self {
            Hash::Sha256 => Pkcs1v15Sign::new::<Sha256>(),
            Hash::Sha384 => Pkcs1v15Sign::new::<Sha384>(),
            Hash::Sha512 => Pkcs1v15Sign::new::<Sha512>(),
        }
    }
}

const SHA1: &str = "The identity provider signs with SHA-1, which g1t does not accept. Set it to sign with SHA-256.";

/// The canonicalization an element names: exclusive, with or without
/// comments, and its inclusive prefixes.
fn exclusive(method: Node) -> Result<(bool, Vec<String>), String> {
    let comments = match method.attribute("Algorithm") {
        Some(EXC_C14N) => false,
        Some(EXC_C14N_COMMENTS) => true,
        other => {
            return Err(format!(
                "The identity provider canonicalizes with {} where g1t needs exclusive canonicalization.",
                other.unwrap_or("nothing")
            ));
        }
    };
    let prefixes = method
        .children()
        .find(|c| c.is_element() && c.tag_name().name() == "InclusiveNamespaces" && c.tag_name().namespace() == Some(EXC_C14N))
        .and_then(|c| c.attribute("PrefixList"))
        .map(|list| list.split_whitespace().map(|p| if p == "#default" { String::new() } else { p.to_owned() }).collect())
        .unwrap_or_default();
    Ok((comments, prefixes))
}

/// Verifies `signature`, an enveloped signature over its parent element.
fn verify_signature(input: &str, signature: Node, certificates: &[Vec<u8>]) -> Result<(), String> {
    let signed = signature.parent_element().ok_or(NOT_SIGNED)?;
    let signed_info = only_child(signature, DSIG, "SignedInfo")?.ok_or(NOT_SIGNED)?;
    let (info_comments, info_prefixes) = exclusive(only_child(signed_info, DSIG, "CanonicalizationMethod")?.ok_or(NOT_SIGNED)?)?;
    let method = only_child(signed_info, DSIG, "SignatureMethod")?.ok_or(NOT_SIGNED)?;
    let hash = Hash::signature_method(method.attribute("Algorithm").unwrap_or_default())?;
    let reference = only_child(signed_info, DSIG, "Reference")?.ok_or(NOT_SIGNED)?;
    let id = signed.attribute("ID").ok_or("The signed element has no ID.")?;
    if reference.attribute("URI") != Some(&format!("#{id}")) {
        return Err("The identity provider's signature covers something other than what it signs.".to_owned());
    }
    let mut enveloped = false;
    let mut canonical: Option<(bool, Vec<String>)> = None;
    if let Some(transforms) = only_child(reference, DSIG, "Transforms")? {
        for transform in children(transforms, DSIG, "Transform") {
            match transform.attribute("Algorithm") {
                Some(ENVELOPED) if canonical.is_none() => enveloped = true,
                Some(EXC_C14N | EXC_C14N_COMMENTS) if canonical.is_none() => canonical = Some(exclusive(transform)?),
                other => {
                    return Err(format!("The identity provider's signature uses a transform g1t does not accept ({}).", other.unwrap_or("none")));
                }
            }
        }
    }
    let Some((comments, prefixes)) = canonical.filter(|_| enveloped) else {
        return Err("The identity provider's signature must be enveloped and use exclusive canonicalization.".to_owned());
    };
    let digest_method = only_child(reference, DSIG, "DigestMethod")?.ok_or(NOT_SIGNED)?;
    let digest_hash = Hash::digest_method(digest_method.attribute("Algorithm").unwrap_or_default())?;
    let expected = only_child(reference, DSIG, "DigestValue")?.map(base64_of).ok_or(NOT_SIGNED)??;
    let content = canonicalize(input, signed, Some(signature.id()), &prefixes, comments);
    if digest_hash.digest(content.as_bytes()) != expected {
        return Err("The signed part of the identity provider's response was changed after it was signed.".to_owned());
    }
    let value = only_child(signature, DSIG, "SignatureValue")?.map(base64_of).ok_or(NOT_SIGNED)??;
    let info = canonicalize(input, signed_info, None, &info_prefixes, info_comments);
    let hashed = hash.digest(info.as_bytes());
    let verified = certificates.iter().any(|der| {
        spki_of(der)
            .and_then(|spki| RsaPublicKey::from_public_key_der(spki).ok())
            .is_some_and(|key| key.verify(hash.scheme(), &hashed, &value).is_ok())
    });
    if verified { Ok(()) } else { Err(BAD_SIGNATURE.to_owned()) }
}

fn base64_of(node: Node) -> Result<Vec<u8>, String> {
    let compact: String = node.text().unwrap_or_default().chars().filter(|c| !c.is_whitespace()).collect();
    STANDARD.decode(compact).map_err(|_| "The identity provider's signature could not be read.".to_owned())
}

// --- Exclusive XML canonicalization (xml-exc-c14n) --------------------------

/// The prefix of a qualified name as written: `""` for none.
fn prefix_of(qname: &str) -> &str {
    qname.split_once(':').map_or("", |(prefix, _)| prefix)
}

/// An element's name as written in the source.
fn element_qname<'i>(input: &'i str, node: Node) -> &'i str {
    let start = node.range().start + 1;
    let rest = &input[start..];
    let end = rest.find(|c: char| c.is_whitespace() || c == '/' || c == '>').unwrap_or(rest.len());
    &rest[..end]
}

/// The subtree at `apex` in exclusive canonical form, leaving out
/// `exclude` (the enveloped signature).
pub fn canonicalize(input: &str, apex: Node, exclude: Option<NodeId>, inclusive: &[String], comments: bool) -> String {
    let mut out = String::new();
    render(input, apex, exclude, inclusive, comments, &[], &mut out);
    out
}

fn render(
    input: &str,
    node: Node,
    exclude: Option<NodeId>,
    inclusive: &[String],
    comments: bool,
    rendered: &[(String, String)],
    out: &mut String,
) {
    let qname = element_qname(input, node);
    let mut needed: Vec<&str> = vec![prefix_of(qname)];
    let mut attributes: Vec<(&str, &str, &str, &str)> = Vec::new();
    for attribute in node.attributes() {
        let written = &input[attribute.range_qname()];
        let prefix = prefix_of(written);
        if !prefix.is_empty() && prefix != "xml" {
            needed.push(prefix);
        }
        attributes.push((attribute.namespace().unwrap_or(""), attribute.name(), written, attribute.value()));
    }
    needed.extend(inclusive.iter().map(String::as_str));
    let mut scope: Vec<(String, String)> = rendered.to_vec();
    let mut declared: Vec<(String, String)> = Vec::new();
    for prefix in needed {
        if prefix == "xml" || declared.iter().any(|(p, _)| p == prefix) {
            continue;
        }
        let uri = node.lookup_namespace_uri((!prefix.is_empty()).then_some(prefix)).unwrap_or("");
        let current = scope.iter().find(|(p, _)| p == prefix).map(|(_, u)| u.as_str());
        let render = if uri.is_empty() {
            // Undeclaring the default only matters when an ancestor set one;
            // a prefix not in scope is not rendered.
            prefix.is_empty() && current.is_some_and(|u| !u.is_empty())
        } else {
            current != Some(uri)
        };
        if render {
            declared.push((prefix.to_owned(), uri.to_owned()));
            scope.retain(|(p, _)| p != prefix);
            scope.push((prefix.to_owned(), uri.to_owned()));
        }
    }
    declared.sort();
    attributes.sort_by(|a, b| (a.0, a.1).cmp(&(b.0, b.1)));
    out.push('<');
    out.push_str(qname);
    for (prefix, uri) in &declared {
        if prefix.is_empty() {
            out.push_str(" xmlns=\"");
        } else {
            out.push_str(" xmlns:");
            out.push_str(prefix);
            out.push_str("=\"");
        }
        escape_attribute(uri, out);
        out.push('"');
    }
    for (_, _, written, value) in &attributes {
        out.push(' ');
        out.push_str(written);
        out.push_str("=\"");
        escape_attribute(value, out);
        out.push('"');
    }
    out.push('>');
    for child in node.children() {
        match child.node_type() {
            NodeType::Element if Some(child.id()) != exclude => render(input, child, exclude, inclusive, comments, &scope, out),
            NodeType::Text => escape_text(child.text().unwrap_or_default(), out),
            NodeType::Comment if comments => {
                out.push_str("<!--");
                out.push_str(child.text().unwrap_or_default());
                out.push_str("-->");
            }
            NodeType::PI => {
                if let Some(pi) = child.pi() {
                    out.push_str("<?");
                    out.push_str(pi.target);
                    if let Some(value) = pi.value.filter(|v| !v.is_empty()) {
                        out.push(' ');
                        out.push_str(value);
                    }
                    out.push_str("?>");
                }
            }
            _ => {}
        }
    }
    out.push_str("</");
    out.push_str(qname);
    out.push('>');
}

fn escape_text(text: &str, out: &mut String) {
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '\r' => out.push_str("&#xD;"),
            c => out.push(c),
        }
    }
}

fn escape_attribute(text: &str, out: &mut String) {
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '"' => out.push_str("&quot;"),
            '\t' => out.push_str("&#x9;"),
            '\n' => out.push_str("&#xA;"),
            '\r' => out.push_str("&#xD;"),
            c => out.push(c),
        }
    }
}

fn escape(text: &str) -> String {
    let mut out = String::new();
    escape_attribute(text, &mut out);
    out.replace('>', "&gt;")
}

// --- Certificates -----------------------------------------------------------

/// One DER item: its tag, its contents, the whole item, and what follows.
type Der<'a> = (u8, &'a [u8], &'a [u8], &'a [u8]);

fn der_item(bytes: &[u8]) -> Option<Der<'_>> {
    let tag = *bytes.first()?;
    let first = *bytes.get(1)?;
    let (length, header) = if first < 0x80 {
        (first as usize, 2)
    } else {
        let count = (first & 0x7f) as usize;
        if count == 0 || count > 4 {
            return None;
        }
        let mut length = 0usize;
        for byte in bytes.get(2..2 + count)? {
            length = (length << 8) | *byte as usize;
        }
        (length, 2 + count)
    };
    let end = header.checked_add(length)?;
    Some((tag, bytes.get(header..end)?, bytes.get(..end)?, bytes.get(end..)?))
}

/// The SubjectPublicKeyInfo of an X.509 certificate, DER.
fn spki_of(certificate: &[u8]) -> Option<&[u8]> {
    let (0x30, certificate, _, _) = der_item(certificate)? else { return None };
    let (0x30, mut tbs, _, _) = der_item(certificate)? else { return None };
    // [0] version, when present; then serial, signature, issuer, validity
    // and subject; then the key.
    if tbs.first() == Some(&0xa0) {
        tbs = der_item(tbs)?.3;
    }
    for _ in 0..5 {
        tbs = der_item(tbs)?.3;
    }
    let (0x30, _, whole, _) = der_item(tbs)? else { return None };
    Some(whole)
}

/// The certificates in what an owner pasted: PEM blocks, or one bare
/// base64 certificate (as some providers download it). Each must hold an
/// RSA key g1t can use.
pub fn certificates_from(pasted: &str) -> Result<Vec<Vec<u8>>, String> {
    let mut blocks: Vec<String> = Vec::new();
    if pasted.contains("-----BEGIN") {
        let mut current: Option<String> = None;
        for line in pasted.lines().map(str::trim) {
            if line.starts_with("-----BEGIN CERTIFICATE") {
                current = Some(String::new());
            } else if line.starts_with("-----END CERTIFICATE") {
                blocks.extend(current.take());
            } else if let Some(block) = current.as_mut() {
                block.push_str(line);
            }
        }
    } else if !pasted.trim().is_empty() {
        blocks.push(pasted.chars().filter(|c| !c.is_whitespace()).collect());
    }
    if blocks.is_empty() {
        return Err("Paste the identity provider's signing certificate (PEM, starting -----BEGIN CERTIFICATE-----).".to_owned());
    }
    let mut out = Vec::new();
    for block in blocks.into_iter().take(4) {
        let der = STANDARD.decode(block).map_err(|_| "That certificate could not be read: paste it in PEM form.".to_owned())?;
        let usable = spki_of(&der).and_then(|spki| RsaPublicKey::from_public_key_der(spki).ok()).is_some();
        if !usable {
            return Err("That certificate holds no RSA key g1t can check signatures with.".to_owned());
        }
        out.push(der);
    }
    Ok(out)
}

/// SHA-256 fingerprint of a certificate, as providers show it: `AB:CD:…`.
pub fn fingerprint(der: &[u8]) -> String {
    Sha256::digest(der).iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(":")
}

// --- What g1t sends ---------------------------------------------------------

/// A request id: starts with a letter, as XML ids must.
pub fn request_id(random_hex: &str) -> String {
    format!("_{random_hex}")
}

/// Where to send the browser: the provider's sign-in URL with the
/// deflated AuthnRequest (HTTP-Redirect binding).
pub fn authn_request_url(sso_url: &str, id: &str, entity_id: &str, acs_url: &str, relay_state: &str, now_ms: u64) -> Option<String> {
    let request = format!(
        "<samlp:AuthnRequest xmlns:samlp=\"{PROTOCOL}\" xmlns:saml=\"{ASSERTION}\" ID=\"{}\" Version=\"2.0\" IssueInstant=\"{}\" Destination=\"{}\" AssertionConsumerServiceURL=\"{}\" ProtocolBinding=\"{POST_BINDING}\"><saml:Issuer>{}</saml:Issuer><samlp:NameIDPolicy Format=\"{UNSPECIFIED_FORMAT}\" AllowCreate=\"true\"/></samlp:AuthnRequest>",
        escape(id),
        issue_instant(now_ms),
        escape(sso_url),
        escape(acs_url),
        escape(entity_id),
    );
    let deflated = miniz_oxide::deflate::compress_to_vec(request.as_bytes(), 6);
    let mut url = worker::Url::parse(sso_url).ok()?;
    if url.scheme() != "https" {
        return None;
    }
    url.query_pairs_mut()
        .append_pair("SAMLRequest", &STANDARD.encode(deflated))
        .append_pair("RelayState", relay_state);
    Some(url.to_string())
}

/// SAML's times: RFC 3339 in UTC, to the second.
fn issue_instant(now_ms: u64) -> String {
    let full = rfc3339(now_ms);
    format!("{}Z", full.split('.').next().unwrap_or(&full))
}

/// g1t's metadata for a workspace, for its provider to read.
pub fn metadata(entity_id: &str, acs_url: &str) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<md:EntityDescriptor xmlns:md=\"{METADATA}\" entityID=\"{}\"><md:SPSSODescriptor AuthnRequestsSigned=\"false\" WantAssertionsSigned=\"true\" protocolSupportEnumeration=\"{PROTOCOL}\"><md:NameIDFormat>{EMAIL_FORMAT}</md:NameIDFormat><md:NameIDFormat>{UNSPECIFIED_FORMAT}</md:NameIDFormat><md:AssertionConsumerService Binding=\"{POST_BINDING}\" Location=\"{}\" index=\"0\" isDefault=\"true\"/></md:SPSSODescriptor></md:EntityDescriptor>\n",
        escape(entity_id),
        escape(acs_url),
    )
}

#[cfg(test)]
#[path = "saml_tests.rs"]
mod tests;
