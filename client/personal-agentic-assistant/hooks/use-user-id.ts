/**
 * useUserID — generates and persists a device-scoped UUID v4 for the current user.
 *
 * The UUID is generated once on first launch, stored in AsyncStorage under a
 * stable key, and returned on every subsequent call. This gives each device a
 * stable identity that the backend uses to:
 *   - Scope RAG retrieval (admin knowledge + personal context).
 *   - Tag tasks so only the owner can see, update, or delete them.
 *
 * Returns an empty string until AsyncStorage resolves — consumers should
 * guard against sending requests while userID === ''.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';

const USER_ID_STORAGE_KEY = '@personal_assistant/user_id';

/** Generates a UUID v4 string using the built-in crypto.randomUUID() available
 *  on Hermes >= React Native 0.71. Falls back to a Math.random()-based
 *  implementation for older environments. */
function generateUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback — not cryptographically secure but sufficient for a local app.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function useUserID(): string {
  const [userID, setUserID] = useState('');

  useEffect(() => {
    AsyncStorage.getItem(USER_ID_STORAGE_KEY).then((stored) => {
      if (stored) {
        setUserID(stored);
      } else {
        const newID = generateUUID();
        AsyncStorage.setItem(USER_ID_STORAGE_KEY, newID);
        setUserID(newID);
      }
    });
  }, []);

  return userID;
}
