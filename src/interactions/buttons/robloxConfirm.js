// src/interactions/buttons/robloxConfirm.js
import { handleRobloxConfirmButton, ROBLOX_CONFIRM_BUTTON_ID } from '../../handlers/robloxVerify.js';

export default {
  name: ROBLOX_CONFIRM_BUTTON_ID,
  execute: handleRobloxConfirmButton,
};
