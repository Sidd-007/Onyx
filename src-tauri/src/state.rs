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
        Ok(db)
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
