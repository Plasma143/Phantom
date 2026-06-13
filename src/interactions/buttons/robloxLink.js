// src/interactions/buttons/robloxLink.js
import { handleRobloxLinkButton, ROBLOX_LINK_BUTTON_ID } from '../../handlers/robloxVerify.js';

export default {
  name: ROBLOX_LINK_BUTTON_ID,
  execute: handleRobloxLinkButton,
};
