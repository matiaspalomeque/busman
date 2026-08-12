use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Key, Nonce,
};
use argon2::Argon2;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};

pub const DATA_KEY_LENGTH: usize = 32;
const SEALED_PAYLOAD_AAD: &[u8] = b"busman-connection-secrets-v1";

#[derive(Debug, Serialize, Deserialize)]
pub struct EncryptedPayload {
    pub version: u32,
    pub algorithm: String,
    pub kdf: String,
    /// Base64-encoded random 16-byte Argon2id salt.
    pub salt: String,
    /// Base64-encoded random 12-byte AES-GCM nonce.
    pub nonce: String,
    /// Base64-encoded ciphertext (includes GCM auth tag).
    pub data: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SealedPayload {
    pub version: u32,
    pub algorithm: String,
    /// Base64-encoded random 12-byte AES-GCM nonce.
    pub nonce: String,
    /// Base64-encoded ciphertext (includes GCM auth tag).
    pub data: String,
}

pub fn generate_data_key() -> [u8; DATA_KEY_LENGTH] {
    let mut key = [0u8; DATA_KEY_LENGTH];
    OsRng.fill_bytes(&mut key);
    key
}

pub fn seal_with_key(
    plaintext: &[u8],
    key_bytes: &[u8; DATA_KEY_LENGTH],
) -> Result<SealedPayload, String> {
    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);

    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key_bytes));
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(
            nonce,
            Payload {
                msg: plaintext,
                aad: SEALED_PAYLOAD_AAD,
            },
        )
        .map_err(|_| "Failed to encrypt connection credentials".to_string())?;

    Ok(SealedPayload {
        version: 1,
        algorithm: "AES-256-GCM".to_string(),
        nonce: BASE64.encode(nonce_bytes),
        data: BASE64.encode(ciphertext),
    })
}

pub fn open_with_key(
    payload: &SealedPayload,
    key_bytes: &[u8; DATA_KEY_LENGTH],
) -> Result<Vec<u8>, String> {
    if payload.version != 1 || payload.algorithm != "AES-256-GCM" {
        return Err("Unsupported encrypted credential format".to_string());
    }

    let nonce_bytes = BASE64
        .decode(&payload.nonce)
        .map_err(|_| "Connection credential store is corrupted".to_string())?;
    let ciphertext = BASE64
        .decode(&payload.data)
        .map_err(|_| "Connection credential store is corrupted".to_string())?;
    if nonce_bytes.len() != 12 {
        return Err("Connection credential store is corrupted".to_string());
    }

    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key_bytes));
    cipher
        .decrypt(
            Nonce::from_slice(&nonce_bytes),
            Payload {
                msg: ciphertext.as_ref(),
                aad: SEALED_PAYLOAD_AAD,
            },
        )
        .map_err(|_| "Connection credential store is corrupted or inaccessible".to_string())
}

fn derive_key(password: &str, salt: &[u8]) -> Result<[u8; 32], String> {
    let argon2 = Argon2::default();
    let mut key = [0u8; 32];
    argon2
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|e| format!("Key derivation failed: {e}"))?;
    Ok(key)
}

pub fn encrypt(plaintext: &[u8], password: &str) -> Result<EncryptedPayload, String> {
    let mut salt = [0u8; 16];
    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut salt);
    rand::thread_rng().fill_bytes(&mut nonce_bytes);

    let key_bytes = derive_key(password, &salt)?;
    let key = Key::<Aes256Gcm>::from_slice(&key_bytes);
    let cipher = Aes256Gcm::new(key);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|_| "Encryption failed".to_string())?;

    Ok(EncryptedPayload {
        version: 1,
        algorithm: "AES-256-GCM".to_string(),
        kdf: "Argon2id".to_string(),
        salt: BASE64.encode(salt),
        nonce: BASE64.encode(nonce_bytes),
        data: BASE64.encode(ciphertext),
    })
}

pub fn decrypt(payload: &EncryptedPayload, password: &str) -> Result<Vec<u8>, String> {
    if payload.version != 1 {
        return Err("Unsupported export format version".to_string());
    }

    let salt = BASE64
        .decode(&payload.salt)
        .map_err(|_| "Invalid password or corrupted file".to_string())?;
    let nonce_bytes = BASE64
        .decode(&payload.nonce)
        .map_err(|_| "Invalid password or corrupted file".to_string())?;
    let ciphertext = BASE64
        .decode(&payload.data)
        .map_err(|_| "Invalid password or corrupted file".to_string())?;

    if nonce_bytes.len() != 12 {
        return Err("Invalid password or corrupted file".to_string());
    }

    let key_bytes = derive_key(password, &salt)?;
    let key = Key::<Aes256Gcm>::from_slice(&key_bytes);
    let cipher = Aes256Gcm::new(key);
    let nonce = Nonce::from_slice(&nonce_bytes);

    cipher
        .decrypt(nonce, ciphertext.as_ref())
        .map_err(|_| "Invalid password or corrupted file".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let plaintext = b"hello world secrets";
        let payload = encrypt(plaintext, "hunter2").unwrap();
        let decrypted = decrypt(&payload, "hunter2").unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn wrong_password_fails() {
        let plaintext = b"sensitive data";
        let payload = encrypt(plaintext, "correct-password").unwrap();
        let result = decrypt(&payload, "wrong-password");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Invalid password"));
    }

    #[test]
    fn tampered_data_fails() {
        let plaintext = b"sensitive data";
        let mut payload = encrypt(plaintext, "password").unwrap();
        let mut data = BASE64.decode(&payload.data).unwrap();
        data[0] ^= 0xff;
        payload.data = BASE64.encode(data);
        let result = decrypt(&payload, "password");
        assert!(result.is_err());
    }

    #[test]
    fn unique_salt_per_export() {
        let plaintext = b"data";
        let p1 = encrypt(plaintext, "pw").unwrap();
        let p2 = encrypt(plaintext, "pw").unwrap();
        assert_ne!(p1.salt, p2.salt);
        assert_ne!(p1.nonce, p2.nonce);
    }

    #[test]
    fn sealed_payload_round_trip() {
        let key = generate_data_key();
        let payload = seal_with_key(b"connection secrets", &key).unwrap();

        assert_eq!(
            open_with_key(&payload, &key).unwrap(),
            b"connection secrets"
        );
    }

    #[test]
    fn sealed_payload_rejects_wrong_key_and_tampering() {
        let key = generate_data_key();
        let wrong_key = generate_data_key();
        let mut payload = seal_with_key(b"connection secrets", &key).unwrap();

        assert!(open_with_key(&payload, &wrong_key).is_err());

        let mut data = BASE64.decode(&payload.data).unwrap();
        data[0] ^= 0xff;
        payload.data = BASE64.encode(data);
        assert!(open_with_key(&payload, &key).is_err());
    }
}
