// src/interactions/buttons/robloxUpdate.js
import { handleRobloxUpdateButton, ROBLOX_UPDATE_BUTTON_ID } from '../../handlers/robloxVerify.js';

export default {
  name: ROBLOX_UPDATE_BUTTON_ID,
  execute: handleRobloxUpdateButton,
};
