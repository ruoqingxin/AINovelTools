use super::*;

impl SecretStore {
    #[must_use]
    pub fn secret_ref(profile_id: Uuid) -> String {
        format!("model-profile:{profile_id}")
    }

    pub fn set(secret_ref: &str, secret: &str) -> Result<(), AiError> {
        if secret.trim().is_empty() {
            return Err(AiError::MissingSecret);
        }
        let result = Entry::new(SECRET_SERVICE, secret_ref)
            .map_err(|_| AiError::SecretStore)
            .and_then(|entry| entry.set_password(secret).map_err(|_| AiError::SecretStore));
        match result {
            Ok(()) => {
                let _ = dpapi_fallback::delete(secret_ref);
                Ok(())
            }
            Err(_) => dpapi_fallback::set(secret_ref, secret),
        }
    }

    pub fn get(secret_ref: &str) -> Result<String, AiError> {
        let result = Entry::new(SECRET_SERVICE, secret_ref)
            .map_err(|_| AiError::SecretStore)
            .and_then(|entry| entry.get_password().map_err(|_| AiError::SecretStore));
        result.or_else(|_| dpapi_fallback::get(secret_ref))
    }

    pub fn delete(secret_ref: &str) -> Result<(), AiError> {
        if let Ok(entry) = Entry::new(SECRET_SERVICE, secret_ref) {
            let _ = entry.delete_credential();
        }
        dpapi_fallback::delete(secret_ref)
    }
}

#[cfg(windows)]
mod dpapi_fallback {
    use std::io::Write;
    use std::path::PathBuf;
    use std::process::{Command, Stdio};

    use super::{AiError, Digest, Sha256};

    const PROTECT_SCRIPT: &str = "$inputText = [Console]::In.ReadToEnd(); $bytes = [Text.Encoding]::UTF8.GetBytes($inputText); $protected = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($protected))";
    const UNPROTECT_SCRIPT: &str = "$encoded = [Console]::In.ReadToEnd(); $protected = [Convert]::FromBase64String($encoded); $bytes = [Security.Cryptography.ProtectedData]::Unprotect($protected, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))";

    pub(super) fn set(secret_ref: &str, secret: &str) -> Result<(), AiError> {
        let encrypted = run(PROTECT_SCRIPT, secret)?;
        let path = secret_path(secret_ref)?;
        std::fs::write(path, encrypted.trim()).map_err(|_| AiError::SecretStore)
    }

    pub(super) fn get(secret_ref: &str) -> Result<String, AiError> {
        let encrypted =
            std::fs::read_to_string(secret_path(secret_ref)?).map_err(|_| AiError::SecretStore)?;
        run(UNPROTECT_SCRIPT, &encrypted)
    }

    pub(super) fn delete(secret_ref: &str) -> Result<(), AiError> {
        let path = secret_path(secret_ref)?;
        match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(AiError::SecretStore),
        }
    }

    fn secret_path(secret_ref: &str) -> Result<PathBuf, AiError> {
        let root = std::env::var_os("LOCALAPPDATA")
            .or_else(|| std::env::var_os("APPDATA"))
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir)
            .join("AINovelTools")
            .join("secrets");
        std::fs::create_dir_all(&root).map_err(|_| AiError::SecretStore)?;
        let digest = Sha256::digest(secret_ref.as_bytes());
        Ok(root.join(format!("{digest:x}.dpapi")))
    }

    fn run(script: &str, input: &str) -> Result<String, AiError> {
        run_with_shell("pwsh.exe", script, input)
            .or_else(|_| run_with_shell("powershell.exe", script, input))
    }

    fn run_with_shell(shell: &str, script: &str, input: &str) -> Result<String, AiError> {
        let mut child = Command::new(shell)
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| AiError::SecretStore)?;
        child
            .stdin
            .as_mut()
            .ok_or(AiError::SecretStore)?
            .write_all(input.as_bytes())
            .map_err(|_| AiError::SecretStore)?;
        let output = child.wait_with_output().map_err(|_| AiError::SecretStore)?;
        if !output.status.success() {
            return Err(AiError::SecretStore);
        }
        String::from_utf8(output.stdout).map_err(|_| AiError::SecretStore)
    }
}

#[cfg(not(windows))]
mod dpapi_fallback {
    use super::AiError;

    pub(super) fn set(_: &str, _: &str) -> Result<(), AiError> {
        Err(AiError::SecretStore)
    }

    pub(super) fn get(_: &str) -> Result<String, AiError> {
        Err(AiError::SecretStore)
    }

    pub(super) fn delete(_: &str) -> Result<(), AiError> {
        Ok(())
    }
}
