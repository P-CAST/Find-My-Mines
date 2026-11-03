import { db } from "../db";
import { createFriendStore } from "./store";
export const friendStore = createFriendStore(db);
