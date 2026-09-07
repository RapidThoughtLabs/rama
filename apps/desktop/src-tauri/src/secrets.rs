use keyring::Entry;

const SERVICE: &str = "com.rapidthoughtlabs.rama";

#[tauri::command]
pub fn set_provider_key(provider: String, key: String) -> Result<(), String> {
    let entry = Entry::new(SERVICE, &provider).map_err(|e| e.to_string())?;
    entry.set_password(&key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_provider_key(provider: String) -> Result<Option<String>, String> {
    let entry = Entry::new(SERVICE, &provider).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

// docs/PROVIDERS_PLAN.md Phase P3 — "removal needs a new Tauri command: secrets.rs has
// set_provider_key and get_provider_key and no delete." Missing-entry is not an error here: the
// caller is removing a provider, and a keyless one (Ollama, a custom local endpoint) never had one.
#[tauri::command]
pub fn delete_provider_key(provider: String) -> Result<(), String> {
    let entry = Entry::new(SERVICE, &provider).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
