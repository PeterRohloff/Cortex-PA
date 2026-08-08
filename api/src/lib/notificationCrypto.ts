// Decrypt Graph change-notification resource data (docs/DESIGN.md §4.2).
// The RSA private key stays in Key Vault: we unwrap the symmetric key via the
// Key Vault CryptographyClient (RSA-OAEP), verify the HMAC-SHA256 signature,
// then AES-CBC decrypt the payload locally. Returns the chatMessage JSON.
import { DefaultAzureCredential } from '@azure/identity';
import { CryptographyClient } from '@azure/keyvault-keys';
import { createHmac, createDecipheriv, timingSafeEqual } from 'crypto';

const credential = new DefaultAzureCredential();
const KV = process.env.KEY_VAULT_NAME!;
const CERT_NAME = process.env.NOTIFICATION_CERT_NAME || 'cortex-notify';
// A KV certificate exposes a key of the same name; address it by name (latest).
const keyId = `https://${KV}.vault.azure.net/keys/${CERT_NAME}`;

let cryptoClient: CryptographyClient | null = null;
function client(): CryptographyClient {
  return (cryptoClient ??= new CryptographyClient(keyId, credential));
}

export interface EncryptedContent {
  data: string;            // base64, AES-CBC ciphertext
  dataSignature: string;   // base64, HMAC-SHA256 over `data`
  dataKey: string;         // base64, RSA-OAEP-wrapped symmetric key
}

export async function decryptResourceData(enc: EncryptedContent): Promise<any> {
  // 1) Unwrap the symmetric key with the KV private key (RSA-OAEP).
  const wrapped = Buffer.from(enc.dataKey, 'base64');
  const { result: symKey } = await client().decrypt({ algorithm: 'RSA-OAEP', ciphertext: wrapped });

  // 2) Verify the payload signature before trusting it.
  const data = Buffer.from(enc.data, 'base64');
  const expected = Buffer.from(enc.dataSignature, 'base64');
  const actual = createHmac('sha256', Buffer.from(symKey)).update(data).digest();
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error('change-notification signature mismatch');
  }

  // 3) AES-CBC decrypt (IV = first 16 bytes of the symmetric key, PKCS7 padding).
  const key = Buffer.from(symKey);
  const iv = key.subarray(0, 16);
  const decipher = createDecipheriv('aes-256-cbc', key, iv);
  const plain = Buffer.concat([decipher.update(data), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}
