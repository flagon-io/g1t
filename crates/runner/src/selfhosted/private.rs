//! The runner's folders, kept to the account that runs it. A runner's
//! folder holds its credential (`config.json`), a Windows job's script
//! while the job runs, and a sandbox's disk; anyone else on the computer
//! who could read them could act as the runner, or look at a job.
//!
//! On Unix a folder is `0700` and its files `0600`. On Windows a folder's
//! permissions come from the folder it is made in: in the user's profile
//! (the default, `~/.g1t-runner`) only its owner, SYSTEM and Administrators
//! can read it, but one made at `C:\runner` (`--dir`, `G1T_RUNNER_DIR`,
//! `--state-dir`) is readable by every user of the computer. So the folder
//! is made private when it is not, and the runner refuses to use one that
//! stays readable by others.

use std::path::Path;

use anyhow::{Context, Result, bail};

/// Writes a file only its owner can read, through a temporary file, so a
/// crash never leaves half of it. On Windows its permissions are its
/// folder's ([`folder`]).
pub fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    let temp = path.with_extension("new");
    std::fs::write(&temp, bytes).with_context(|| format!("could not write {}", temp.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(&temp, path).with_context(|| format!("could not write {}", path.display()))?;
    Ok(())
}

/// Makes `dir` if it is not there, and makes sure only this account (and,
/// on Windows, SYSTEM and Administrators) can read it: tightened if it is
/// open to others, and refused if it stays so. `option` is how a person
/// picks another folder (`--dir`, `--state-dir`).
pub fn folder(dir: &Path, option: &str) -> Result<()> {
    std::fs::create_dir_all(dir).with_context(|| format!("could not make {}", dir.display()))?;
    let open = readers(dir);
    if open.is_empty() {
        return Ok(());
    }
    let tightened = tighten(dir);
    let still = readers(dir);
    if still.is_empty() {
        return Ok(());
    }
    let why = tightened.err().map(|e| format!(" ({e:#})")).unwrap_or_default();
    bail!(
        "{} can be read by {}, and could not be made private to this account{why}. It holds the runner's credential: {}, or pick a folder in your own profile with {option}",
        dir.display(),
        still.join(", "),
        fix(dir)
    )
}

/// Who other than this account can read `dir`, as a person names them;
/// empty when no one.
pub fn readers(dir: &Path) -> Vec<String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let Ok(meta) = std::fs::metadata(dir) else { return Vec::new() };
        unix_readers(meta.permissions().mode())
    }
    #[cfg(windows)]
    {
        match windows::sddl(dir) {
            Some(sddl) => broad_readers(&sddl),
            None => Vec::new(),
        }
    }
}

#[cfg(unix)]
fn tighten(dir: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).with_context(|| format!("could not chmod {}", dir.display()))
}

#[cfg(windows)]
fn tighten(dir: &Path) -> Result<()> {
    let Some(user) = windows::user_sid() else { bail!("could not tell which account this is") };
    for args in icacls_args(&dir.display().to_string(), &user) {
        let mut command = std::process::Command::new("icacls");
        command.args(&args).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::piped());
        super::native::hide_window(&mut command);
        let output = command.output().context("could not run icacls")?;
        if !output.status.success() {
            bail!("icacls: {}", String::from_utf8_lossy(&output.stderr).trim());
        }
    }
    Ok(())
}

fn fix(dir: &Path) -> String {
    if cfg!(windows) {
        format!(
            "in {}'s Properties, Security, Advanced, turn off inheritance and leave only yourself, SYSTEM and Administrators",
            dir.display()
        )
    } else {
        format!("run `chmod 700 {}` as its owner", dir.display())
    }
}

/// Who a Unix folder's mode lets in besides its owner.
#[cfg_attr(not(unix), allow(dead_code))]
fn unix_readers(mode: u32) -> Vec<String> {
    let mut who = Vec::new();
    if mode & 0o040 != 0 {
        who.push("its group".to_owned());
    }
    if mode & 0o004 != 0 {
        who.push("every user".to_owned());
    }
    who
}

/// The well-known groups that mean every (or any) user of a Windows
/// computer, by SID and by SDDL's short name.
#[cfg_attr(not(windows), allow(dead_code))]
const BROAD: &[(&str, &str, &str)] = &[
    ("S-1-1-0", "WD", "Everyone"),
    ("S-1-5-32-545", "BU", "Users"),
    ("S-1-5-11", "AU", "Authenticated Users"),
    ("S-1-5-4", "IU", "Interactive users"),
    ("S-1-5-7", "AN", "Anonymous"),
    ("S-1-5-32-546", "BG", "Guests"),
];

/// Who of [`BROAD`] a folder's DACL, in SDDL (`D:PAI(A;OICI;FA;;;SY)…`),
/// lets read it. A folder with no DACL at all lets everyone in.
#[cfg_attr(not(windows), allow(dead_code))]
fn broad_readers(sddl: &str) -> Vec<String> {
    let Some(start) = sddl.find("D:") else { return vec!["Everyone".to_owned()] };
    let dacl = &sddl[start + 2..];
    // The SACL, if it was asked for, follows the DACL.
    let dacl = dacl.find("S:").map_or(dacl, |end| &dacl[..end]);
    if dacl.starts_with("NO_ACCESS_CONTROL") {
        return vec!["Everyone".to_owned()];
    }
    let mut who = Vec::new();
    for ace in dacl.split('(').skip(1).filter_map(|rest| rest.split(')').next()) {
        let fields: Vec<&str> = ace.split(';').collect();
        let [kind, _flags, rights, _, _, sid, ..] = fields[..] else { continue };
        if !matches!(kind, "A" | "XA") || !reads(rights) {
            continue;
        }
        if let Some((_, _, name)) = BROAD.iter().find(|(long, short, _)| sid.eq_ignore_ascii_case(long) || sid == *short)
            && !who.iter().any(|w| w == name)
        {
            who.push((*name).to_owned());
        }
    }
    who
}

/// Whether an ACE's rights, in SDDL, include reading a file's contents.
#[cfg_attr(not(windows), allow(dead_code))]
fn reads(rights: &str) -> bool {
    // FILE_READ_DATA, GENERIC_ALL, GENERIC_READ.
    const READ: u32 = 0x1 | 0x1000_0000 | 0x8000_0000;
    if let Some(hex) = rights.strip_prefix("0x").or_else(|| rights.strip_prefix("0X")) {
        return u32::from_str_radix(hex, 16).is_ok_and(|mask| mask & READ != 0);
    }
    if let Ok(mask) = rights.parse::<u32>() {
        return mask & READ != 0;
    }
    // Two letters a right: `FA` all, `FR` read, `GA`/`GR` generic all and
    // read, `CC` (bit 0, which for a file is reading its data).
    rights.as_bytes().chunks(2).any(|code| matches!(code, b"FA" | b"FR" | b"GA" | b"GR" | b"KA" | b"KR" | b"CC"))
}

/// The `icacls` commands that leave a folder to `user`, SYSTEM and
/// Administrators only, inherited by what is in it: no permissions from
/// the folder above, and none for the groups that mean everyone.
#[cfg_attr(not(windows), allow(dead_code))]
fn icacls_args(dir: &str, user: &str) -> Vec<Vec<String>> {
    let mut grant = vec![dir.to_owned(), "/inheritance:r".into(), "/grant:r".into()];
    for sid in ["S-1-5-18", "S-1-5-32-544", user] {
        grant.push(format!("*{sid}:(OI)(CI)F"));
    }
    let mut remove = vec![dir.to_owned(), "/remove:g".into()];
    remove.extend(BROAD.iter().map(|(sid, _, _)| format!("*{sid}")));
    vec![grant, remove]
}

#[cfg(windows)]
mod windows {
    //! Reading a folder's permissions and this process's account, from
    //! Windows' own calls: SDDL and SIDs, which are the same in every
    //! language, where `icacls`' listing names groups in the computer's.

    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use std::ptr::null_mut;

    type Handle = *mut core::ffi::c_void;

    const SE_FILE_OBJECT: i32 = 1;
    const DACL_SECURITY_INFORMATION: u32 = 4;
    const SDDL_REVISION_1: u32 = 1;
    const TOKEN_QUERY: u32 = 8;
    const TOKEN_USER: i32 = 1;

    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn GetNamedSecurityInfoW(
            name: *const u16,
            object: i32,
            info: u32,
            owner: *mut Handle,
            group: *mut Handle,
            dacl: *mut Handle,
            sacl: *mut Handle,
            descriptor: *mut Handle,
        ) -> u32;
        fn ConvertSecurityDescriptorToStringSecurityDescriptorW(
            descriptor: Handle,
            revision: u32,
            info: u32,
            text: *mut *mut u16,
            length: *mut u32,
        ) -> i32;
        fn OpenProcessToken(process: Handle, access: u32, token: *mut Handle) -> i32;
        fn GetTokenInformation(token: Handle, class: i32, info: *mut core::ffi::c_void, length: u32, returned: *mut u32) -> i32;
        fn ConvertSidToStringSidW(sid: Handle, text: *mut *mut u16) -> i32;
    }

    unsafe extern "system" {
        fn LocalFree(memory: Handle) -> Handle;
        fn GetCurrentProcess() -> Handle;
        fn CloseHandle(handle: Handle) -> i32;
    }

    /// A string Windows allocated, read and freed.
    unsafe fn take(text: *mut u16) -> String {
        let mut length = 0;
        while unsafe { *text.add(length) } != 0 {
            length += 1;
        }
        let read = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(text, length) });
        unsafe { LocalFree(text.cast()) };
        read
    }

    /// A file or folder's DACL, in SDDL.
    pub fn sddl(path: &Path) -> Option<String> {
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut descriptor: Handle = null_mut();
        let error = unsafe {
            GetNamedSecurityInfoW(
                wide.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                null_mut(),
                null_mut(),
                &mut descriptor,
            )
        };
        if error != 0 || descriptor.is_null() {
            return None;
        }
        let mut text: *mut u16 = null_mut();
        let converted = unsafe {
            ConvertSecurityDescriptorToStringSecurityDescriptorW(
                descriptor,
                SDDL_REVISION_1,
                DACL_SECURITY_INFORMATION,
                &mut text,
                null_mut(),
            )
        };
        unsafe { LocalFree(descriptor) };
        (converted != 0 && !text.is_null()).then(|| unsafe { take(text) })
    }

    /// This process's account's SID: `S-1-5-21-…`.
    pub fn user_sid() -> Option<String> {
        let mut token: Handle = null_mut();
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
            return None;
        }
        // TOKEN_USER and the SID after it; usize keeps its pointer aligned.
        let mut buffer = vec![0usize; 64];
        let mut returned = 0u32;
        let ok = unsafe {
            GetTokenInformation(token, TOKEN_USER, buffer.as_mut_ptr().cast(), (buffer.len() * size_of::<usize>()) as u32, &mut returned)
        };
        unsafe { CloseHandle(token) };
        if ok == 0 {
            return None;
        }
        // TOKEN_USER begins with the SID's pointer.
        let sid = buffer[0] as Handle;
        let mut text: *mut u16 = null_mut();
        if unsafe { ConvertSidToStringSidW(sid, &mut text) } == 0 || text.is_null() {
            return None;
        }
        Some(unsafe { take(text) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_folder_open_to_every_user_is_found_by_its_groups() {
        // C:\runner, made under C:\: Users read it, Authenticated Users change it.
        let open = "D:AI(A;OICIID;FA;;;BA)(A;OICIID;FA;;;SY)(A;OICIID;0x1200a9;;;BU)(A;ID;0x1301bf;;;AU)(A;OICIIOID;SDGXGWGR;;;AU)";
        assert_eq!(broad_readers(open), ["Users", "Authenticated Users"]);
        // The user's profile, or a folder made private.
        let private = "D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;S-1-5-21-1-2-3-1001)";
        assert!(broad_readers(private).is_empty());
        // Everyone, by SID; and a right to list and traverse only, which reads nothing.
        assert_eq!(broad_readers("D:(A;;0x120089;;;S-1-1-0)"), ["Everyone"]);
        assert!(broad_readers("D:(A;;0x100020;;;WD)").is_empty());
        // A deny is no way in, and no DACL at all is every way in.
        assert!(broad_readers("D:(D;;FA;;;WD)").is_empty());
        assert_eq!(broad_readers("D:NO_ACCESS_CONTROL"), ["Everyone"]);
        assert_eq!(broad_readers("O:BAG:SY"), ["Everyone"]);
    }

    #[test]
    fn rights_that_read_a_file_are_told_from_those_that_do_not() {
        assert!(reads("FA") && reads("FR") && reads("GR") && reads("0x1200a9") && reads("0x80000000") && reads("1"));
        assert!(!reads("FX") && !reads("SDGXGW") && !reads("0x100020") && !reads(""));
    }

    #[test]
    fn a_folder_is_left_to_its_owner_system_and_administrators() {
        let [grant, remove] = &icacls_args(r"C:\runner", "S-1-5-21-1-2-3-1001")[..] else { panic!() };
        assert_eq!(
            grant,
            &[
                r"C:\runner",
                "/inheritance:r",
                "/grant:r",
                "*S-1-5-18:(OI)(CI)F",
                "*S-1-5-32-544:(OI)(CI)F",
                "*S-1-5-21-1-2-3-1001:(OI)(CI)F"
            ]
        );
        assert_eq!(remove[..2], [r"C:\runner", "/remove:g"]);
        for sid in ["*S-1-1-0", "*S-1-5-32-545", "*S-1-5-11"] {
            assert!(remove.iter().any(|a| a == sid), "{sid}");
        }
    }

    #[test]
    fn a_unix_folder_is_open_when_its_group_or_others_may_read_it() {
        assert!(unix_readers(0o700).is_empty());
        assert!(unix_readers(0o711).is_empty());
        assert_eq!(unix_readers(0o750), ["its group"]);
        assert_eq!(unix_readers(0o755), ["its group", "every user"]);
    }

    #[test]
    fn a_folder_the_runner_makes_is_private() {
        let dir = std::env::temp_dir().join(format!("g1t-private-{}", std::process::id())).join("state");
        folder(&dir, "--dir").unwrap();
        assert!(readers(&dir).is_empty(), "{:?}", readers(&dir));
        write_private(&dir.join("config.json"), b"{}").unwrap();
        assert_eq!(std::fs::read(dir.join("config.json")).unwrap(), b"{}");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
            assert_eq!(std::fs::metadata(dir.join("config.json")).unwrap().permissions().mode() & 0o777, 0o600);
        }
        #[cfg(windows)]
        assert!(windows::user_sid().is_some_and(|sid| sid.starts_with("S-1-")));
        let _ = std::fs::remove_dir_all(dir.parent().unwrap());
    }

    /// Makes a folder every user can read and tightens it: run with
    /// `cargo test -p g1t-runner -- --ignored a_folder_every_user_can_read`
    /// on Windows (it uses `C:\Users\Public`).
    #[test]
    #[ignore]
    #[cfg(windows)]
    fn a_folder_every_user_can_read_is_made_private() {
        let dir = std::path::PathBuf::from(format!(r"C:\Users\Public\g1t-private-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!readers(&dir).is_empty(), "Public is open to every user");
        folder(&dir, "--dir").unwrap();
        assert!(readers(&dir).is_empty(), "{:?}", windows::sddl(&dir));
        let sddl = windows::sddl(&dir).unwrap();
        assert!(sddl.starts_with("D:P"), "no permissions from the folder above: {sddl}");
        std::fs::write(dir.join("config.json"), "{}").unwrap();
        assert!(readers(&dir.join("config.json")).is_empty(), "{:?}", windows::sddl(&dir.join("config.json")));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
