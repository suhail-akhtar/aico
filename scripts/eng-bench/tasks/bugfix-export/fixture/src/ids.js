import crypto from 'node:crypto';

export function newTransactionId() {
  return `tx_${crypto.randomBytes(8).toString('hex')}`;
}
