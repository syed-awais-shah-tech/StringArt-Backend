/**
 * settingsService.js — Store Settings Service (Admin-Controlled Thread Generation Modes)
 *
 * Requirements:
 *   - Backed by Supabase `store_settings` table.
 *   - Only one settings row used.
 *   - Default: eight_color_enabled = false.
 *   - Fallback protection ensures rock-solid uptime and test reliability.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { supabase } from '../supabase.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

// In-memory cache for ultra-fast response & offline resilience
let cachedSettings = {
  eight_color_enabled: false,
};
let isInitialized = false;

/**
 * Read local fallback settings file if present
 */
function readLocalFallback() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (fs.existsSync(SETTINGS_FILE)) {
      const content = fs.readFileSync(SETTINGS_FILE, 'utf-8');
      const parsed = JSON.parse(content);
      if (typeof parsed.eight_color_enabled === 'boolean') {
        return { eight_color_enabled: parsed.eight_color_enabled };
      }
    }
  } catch (err) {
    console.warn('[settingsService] Could not read local fallback settings:', err.message);
  }
  return { eight_color_enabled: false };
}

/**
 * Persist fallback settings locally
 */
function writeLocalFallback(settings) {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[settingsService] Could not persist local fallback settings:', err.message);
  }
}

/**
 * Fetch current store settings from Supabase (or fallback cache)
 *
 * @returns {Promise<{ eight_color_enabled: boolean, eightColorEnabled: boolean }>}
 */
export async function getStoreSettings() {
  try {
    const { data, error } = await supabase
      .from('store_settings')
      .select('id, eight_color_enabled')
      .limit(1)
      .maybeSingle();

    if (!error && data) {
      const enabled = Boolean(data.eight_color_enabled);
      cachedSettings = { eight_color_enabled: enabled };
      writeLocalFallback(cachedSettings);
      return {
        eight_color_enabled: enabled,
        eightColorEnabled: enabled,
      };
    }

    if (error) {
      // If table is not migrated yet or cache not refreshed, use fallback
      if (!isInitialized) {
        cachedSettings = readLocalFallback();
        isInitialized = true;
      }
    }
  } catch (err) {
    console.warn('[settingsService] Error loading settings from Supabase:', err.message);
    if (!isInitialized) {
      cachedSettings = readLocalFallback();
      isInitialized = true;
    }
  }

  const enabled = Boolean(cachedSettings.eight_color_enabled);
  return {
    eight_color_enabled: enabled,
    eightColorEnabled: enabled,
  };
}

/**
 * Update store settings in Supabase & local cache
 * PATCH allows admin to change: eight_color_enabled
 *
 * @param {{ eight_color_enabled: boolean }} updates
 * @returns {Promise<{ eight_color_enabled: boolean, eightColorEnabled: boolean }>}
 */
export async function updateStoreSettings(updates = {}) {
  // Extract and normalize eight_color_enabled
  let newEnabled = undefined;
  if (typeof updates.eight_color_enabled === 'boolean') {
    newEnabled = updates.eight_color_enabled;
  } else if (typeof updates.eightColorEnabled === 'boolean') {
    newEnabled = updates.eightColorEnabled;
  } else if (updates.eight_color_enabled === 'true' || updates.eightColorEnabled === 'true') {
    newEnabled = true;
  } else if (updates.eight_color_enabled === 'false' || updates.eightColorEnabled === 'false') {
    newEnabled = false;
  }

  if (newEnabled === undefined) {
    throw new Error('eight_color_enabled must be a boolean (true or false).');
  }

  // Update in-memory and local fallback
  cachedSettings = { eight_color_enabled: newEnabled };
  writeLocalFallback(cachedSettings);

  try {
    // Check if a row already exists in Supabase
    const { data: existingRow, error: selectError } = await supabase
      .from('store_settings')
      .select('id')
      .limit(1)
      .maybeSingle();

    if (!selectError) {
      if (existingRow && existingRow.id) {
        const { error: updateError } = await supabase
          .from('store_settings')
          .update({
            eight_color_enabled: newEnabled,
            updated_at: new Date().toISOString(),
          })
          .eq('id', existingRow.id);

        if (updateError) {
          console.warn('[settingsService] Supabase update warning:', updateError.message);
        }
      } else {
        const { error: insertError } = await supabase
          .from('store_settings')
          .insert({
            eight_color_enabled: newEnabled,
          });

        if (insertError) {
          console.warn('[settingsService] Supabase insert warning:', insertError.message);
        }
      }
    }
  } catch (err) {
    console.warn('[settingsService] Exception persisting to Supabase:', err.message);
  }

  return {
    eight_color_enabled: newEnabled,
    eightColorEnabled: newEnabled,
  };
}

/**
 * Reset cache (for test isolation)
 */
export function resetSettingsCache() {
  cachedSettings = { eight_color_enabled: false };
  writeLocalFallback(cachedSettings);
  isInitialized = true;
}
