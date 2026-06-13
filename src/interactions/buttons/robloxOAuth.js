// src/interactions/buttons/robloxOAuth.js
import { handleRobloxOAuthButton, ROBLOX_OAUTH_BUTTON_ID } from '../../handlers/robloxVerify.js';

export default {
  name: ROBLOX_OAUTH_BUTTON_ID,
  execute: handleRobloxOAuthButton,
};
