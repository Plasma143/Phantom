// src/utils/clientRef.js
// Stores a reference to the Discord client so it can be accessed
// from web routes (robloxOAuth, etc.) without circular imports.

let _client = null;

export function setClient(client) {
  _client = client;
}

export function getClient() {
  return _client;
}
