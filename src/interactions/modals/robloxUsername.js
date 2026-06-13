// src/interactions/modals/robloxUsername.js
import { handleRobloxUsernameModal, USERNAME_MODAL_ID } from '../../handlers/robloxVerify.js';

export default {
  name: USERNAME_MODAL_ID,
  execute: handleRobloxUsernameModal,
};
