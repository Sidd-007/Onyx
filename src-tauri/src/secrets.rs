//! The Keychain holds one item: the key to Onyx's encrypted vault (see `appdb`), which
//! stores everything else. One item means at most one macOS prompt per launch.
//! Older versions kept each password as its own item; those are read once and moved.

use security_framework::passwords;
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::error::{AppError, Result};

const SERVICE: &str = "dev.siddhant.onyx";
const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

/// A connection's database password.
pub fn password_account(conn_id: &Uuid) -> String {
    conn_id.to_string()
}

/// A connection's SSH password or key passphrase.
pub fn ssh_account(conn_id: &Uuid) -> String {
    format!("{conn_id}:ssh")
}

/// The app database's encryption key: 32 random bytes as hex, created on first use.
pub fn app_db_key() -> Result<Zeroizing<String>> {
    const ACCOUNT: &str = "app-db-key";
    match passwords::get_generic_password(SERVICE, ACCOUNT) {
        Ok(bytes) => String::from_utf8(bytes)
            .map(Zeroizing::new)
            .map_err(|_| AppError::Keychain("app database key is not UTF-8".into())),
        Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => {
            let key = Zeroizing::new(hex::encode(Zeroizing::new(rand::random::<[u8; 32]>())));
            passwords::set_generic_password(SERVICE, ACCOUNT, key.as_bytes())
                .map_err(|e| AppError::Keychain(e.to_string()))?;
            Ok(key)
        }
        Err(e) => Err(AppError::Keychain(e.to_string())),
    }
}


/// A secret an earlier Onyx kept in the Keychain; secrets now live in the vault.
pub fn legacy_secret(account: &str) -> Result<Option<Zeroizing<String>>> {
    match passwords::get_generic_password(SERVICE, account) {
        Ok(bytes) => {
            let bytes = Zeroizing::new(bytes);
            let secret = String::from_utf8(bytes.to_vec())
                .map_err(|_| AppError::Keychain("stored secret is not UTF-8".into()))?;
            Ok(Some(Zeroizing::new(secret)))
        }
        Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(None),
        Err(e) => Err(AppError::Keychain(e.to_string())),
    }
}

pub fn delete_legacy_secret(account: &str) -> Result<()> {
    match passwords::delete_generic_password(SERVICE, account) {
        Ok(()) => Ok(()),
        Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(()),
        Err(e) => Err(AppError::Keychain(e.to_string())),
    }
}
