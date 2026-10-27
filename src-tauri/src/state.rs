use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tokio::sync::RwLock;
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::appdb::AppDb;
use crate::connections::{ConnectionConfig, ConnectionStore};
use crate::error::{AppError, Result};
use crate::secrets;
use crate::db::Session;

pub struct AppState {
    pub store: Mutex<ConnectionStore>,
    pub sessions: RwLock<HashMap<Uuid, Arc<Session>>>,
    vault: Mutex<Option<Arc<AppDb>>>,
    vault_path: PathBuf,
}

impl AppState {
    pub fn new(store: ConnectionStore, vault_path: PathBuf) -> Self {
        Self {
            store: Mutex::new(store),
            sessions: RwLock::new(HashMap::new()),
            vault: Mutex::new(None),
            vault_path,
        }
    }

    /// The vault, unlocked on first use (the one Keychain read, so one prompt per launch).
    /// If access is denied, the next call asks again.
    pub fn vault(&self) -> Result<Arc<AppDb>> {
        let mut vault = self.vault.lock().unwrap();
        if let Some(db) = vault.as_ref() {
            return Ok(db.clone());
        }
        let key = secrets::app_db_key().map_err(|e| AppError::Locked(e.to_string()))?;
        let db = Arc::new(AppDb::open(&self.vault_path, &key)?);
        *vault = Some(db.clone());
        drop(vault);
        self.move_url_credentials(&db)?;
        Ok(db)
    }

    fn move_url_credentials(&self, vault: &AppDb) -> Result<()> {
        move_url_credentials(&mut self.store.lock().unwrap(), vault)
    }

    /// A connection secret from the vault. One that an older version kept in the
    /// Keychain is moved into the vault the first time it's needed.
    pub fn secret(&self, account: &str) -> Result<Option<Zeroizing<String>>> {
        let vault = self.vault()?;
        if let Some(secret) = vault.secret(account)? {
            return Ok(Some(secret));
        }
        let Some(legacy) = secrets::legacy_secret(account)? else { return Ok(None) };
        vault.set_secret(account, &legacy)?;
        let _ = secrets::delete_legacy_secret(account);
        Ok(Some(legacy))
    }

    /// `None` keeps the stored secret, `Some("")` removes it, anything else replaces it.
    pub fn update_secret(&self, account: &str, secret: Option<&str>) -> Result<()> {
        match secret {
            None => Ok(()),
            Some("") => self.delete_secret(account),
            Some(s) => self.vault()?.set_secret(account, s),
        }
    }

    pub fn delete_secret(&self, account: &str) -> Result<()> {
        self.vault()?.delete_secret(account)?;
        let _ = secrets::delete_legacy_secret(account);
        Ok(())
    }

    pub fn config(&self, id: &Uuid) -> Result<ConnectionConfig> {
        self.store.lock().unwrap().get(id).cloned().ok_or_else(|| AppError::Invalid("Unknown connection".into()))
    }

    pub async fn session(&self, id: &Uuid) -> Result<Arc<Session>> {
        self.sessions.read().await.get(id).cloned().ok_or(AppError::NotConnected)
    }
}

/// Connections saved before passwords were kept out of MongoDB addresses: each password moves
/// into the vault (unless one is already there) and the address is saved without it.
fn move_url_credentials(store: &mut crate::connections::ConnectionStore, vault: &AppDb) -> Result<()> {
    let found: Vec<_> = store
        .list()
        .iter()
        .filter_map(|c| {
            let mut clean = c.clone();
            let password = clean.take_url_credentials();
            (clean.host != c.host).then_some((clean, password))
        })
        .collect();
    for (clean, password) in found {
        let account = secrets::password_account(&clean.id);
        if let Some(p) = password.filter(|p| !p.is_empty())
            && vault.secret(&account)?.is_none()
        {
            vault.set_secret(&account, &p)?;
        }
        store.upsert(clean)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connections::{ConnectionConfig, ConnectionStore, Engine};

    #[test]
    fn old_mongodb_addresses_lose_their_passwords_to_the_vault() {
        let path = std::env::temp_dir().join(format!("onyx-conns-{}.json", uuid::Uuid::new_v4().simple()));
        let mut config = crate::bulk_test_config(std::path::Path::new("x"));
        config.engine = Engine::Mongodb;
        config.host = "mongodb://ann:hunter2@db.example.com:27017/shop".into();
        config.user = String::new();
        let id = config.id;
        std::fs::write(&path, serde_json::to_vec(&vec![config]).unwrap()).unwrap();

        let mut store = ConnectionStore::load(path.clone()).unwrap();
        let vault = AppDb::in_memory();
        move_url_credentials(&mut store, &vault).unwrap();

        let on_disk = std::fs::read_to_string(&path).unwrap();
        assert!(!on_disk.contains("hunter2"), "{on_disk}");
        let saved: Vec<ConnectionConfig> = serde_json::from_str(&on_disk).unwrap();
        assert_eq!((saved[0].host.as_str(), saved[0].user.as_str()), ("mongodb://db.example.com:27017/shop", "ann"));
        assert_eq!(vault.secret(&secrets::password_account(&id)).unwrap().as_deref().map(String::as_str), Some("hunter2"));
        std::fs::remove_file(&path).unwrap();
    }
}
