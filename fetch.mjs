import { relayInit } from 'nostr-tools';
import WebSocket from 'ws'; // Ensure ws is installed, nostr-tools might use it
import fs from 'fs/promises';
import path from 'path';
import { SPAM_EVENTS_FILE, spamConstants, analyzeEventForSpam } from './lib/spamUtils.mjs';

const RELAY_URL = 'wss://relay.damus.io';
const RAW_EVENTS_FILE = 'raw.jsonl'; // Keep this here or in a general constants file

// connectToRelay function (remains the same)
async function connectToRelay(url) {
  const relay = relayInit(url);
  relay.on('connect', () => console.log(`Connected to ${relay.url}`));
  relay.on('error', (err) => console.error(`Failed to connect to ${relay.url}:`, err));
  relay.on('disconnect', () => console.log(`Disconnected from ${relay.url}`));
  try {
    await relay.connect();
  } catch (error) {
    console.error(`Connection error with ${url}:`, error);
    return null;
  }
  return relay;
}

// fetchPaginatedEvents function (remains the same)
async function fetchPaginatedEvents(relay) {
  const uniqueEvents = new Map();
  let currentUntil = Math.floor(Date.now() / 1000);
  const initialSince = currentUntil - 3600; // 1 hour ago
  let totalFetched = 0;

  console.log(`Starting event fetch: until=${currentUntil}, since=${initialSince}`);
  try {
    await fs.writeFile(RAW_EVENTS_FILE, '');
    console.log(`Initialized ${RAW_EVENTS_FILE}`);
  } catch (err) {
    console.error(`Error initializing ${RAW_EVENTS_FILE}:`, err);
  }

  while (true) {
    const filter = { kinds: [1], limit: 100, until: currentUntil, since: initialSince };
    console.log(`Subscribing with filter:`, filter);
    const eventsInBatch = [];
    let sub = relay.sub([filter]);

    await new Promise((resolve, reject) => {
      sub.on('event', async (event) => {
        if (!uniqueEvents.has(event.id)) {
          uniqueEvents.set(event.id, event);
          eventsInBatch.push(event);
          totalFetched++;
          console.log(JSON.stringify(event));
          try {
            const eventString = JSON.stringify(event);
            await fs.appendFile(RAW_EVENTS_FILE, eventString + '\n');
          } catch (err) {
            console.error(`Error appending event ${event.id} to ${RAW_EVENTS_FILE}:`, err);
          }
        }
      });
      sub.on('eose', () => {
        console.log(`EOSE received for until=${currentUntil}. Batch size: ${eventsInBatch.length}, Total unique: ${totalFetched}`);
        sub.unsub();
        resolve();
      });
      sub.on('error', (err) => {
        console.error('Subscription error:', err);
        sub.unsub();
        reject(err);
      });
      const subTimeout = setTimeout(() => {
        console.warn(`Subscription timeout for filter:`, filter);
        sub.unsub();
        resolve();
      }, 30000);
      sub.on('eose', () => clearTimeout(subTimeout));
      sub.on('error', () => clearTimeout(subTimeout));
    });

    if (eventsInBatch.length === 0) {
      console.log('No new events received in this batch. Stopping pagination.');
      break;
    }
    eventsInBatch.sort((a, b) => b.created_at - a.created_at);
    const oldestEventInBatch = eventsInBatch[eventsInBatch.length - 1];
    if (!oldestEventInBatch) {
        console.log('No oldest event found, though batch was not empty. Stopping.');
        break;
    }
    currentUntil = Math.floor(oldestEventInBatch.created_at);
    console.log(`Oldest event created_at: ${oldestEventInBatch.created_at}, new until: ${currentUntil}`);
    if (currentUntil <= initialSince) {
      console.log('New `until` timestamp is less than or equal to initial `since`. Stopping pagination.');
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  console.log(`Fetching complete. Total unique events collected: ${uniqueEvents.size}`);
  return Array.from(uniqueEvents.values());
}

// detectSpam function (remains largely the same)
async function detectSpam() {
  console.log(`Starting spam detection from ${RAW_EVENTS_FILE} using modular functions.`);
  const identifiedSpamEvents = new Map(); // To count unique spam events identified

  try {
    // Check if RAW_EVENTS_FILE exists and has content.
    // This check is also present in IIFE, but good to have robustness here too.
    try {
      await fs.access(RAW_EVENTS_FILE);
    } catch (e) {
      console.log(`${RAW_EVENTS_FILE} not found by detectSpam. Skipping.`);
      await fs.writeFile(SPAM_EVENTS_FILE, ''); // Ensure spam file is empty
      console.log(`Initialized ${SPAM_EVENTS_FILE} as empty.`);
      return [];
    }

    const fileContent = await fs.readFile(RAW_EVENTS_FILE, 'utf-8');
    const lines = fileContent.split('\n').filter(line => line.trim() !== '');

    if (lines.length === 0) {
        console.log(`${RAW_EVENTS_FILE} is empty. Skipping spam detection.`);
        await fs.writeFile(SPAM_EVENTS_FILE, ''); // Ensure spam file is empty
        console.log(`Initialized ${SPAM_EVENTS_FILE} as empty.`);
        return [];
    }

    // Initialize spam.jsonl (clear it before appending)
    await fs.writeFile(SPAM_EVENTS_FILE, '');
    console.log(`Initialized ${SPAM_EVENTS_FILE}`);

    const pubkeyActivity = {}; // Store history: { pubkey: [{content, created_at, id}, ...] }

    for (const line of lines) {
      const event = JSON.parse(line);

      // Ensure pubkey entry exists in activity log
      if (!pubkeyActivity[event.pubkey]) {
        pubkeyActivity[event.pubkey] = [];
      }
      // userEventHistory is the history *before* this current event
      const userEventHistory = pubkeyActivity[event.pubkey];

      // Analyze the event using the history *before* this event
      const reasons = analyzeEventForSpam(event, userEventHistory, spamConstants);

      if (reasons.length > 0) {
        // Check if this specific event ID has already been marked as spam (e.g. if raw.jsonl had duplicates)
        if (!identifiedSpamEvents.has(event.id)) {
          event.spamReasons = reasons;
          identifiedSpamEvents.set(event.id, event);
          try {
            await fs.appendFile(SPAM_EVENTS_FILE, JSON.stringify(event) + '\n');
          } catch (err) {
            console.error(`Error appending spam event ${event.id} to ${SPAM_EVENTS_FILE}:`, err);
          }
        }
      }

      // Add current event's details to its pubkey's history for analysis of subsequent events
      userEventHistory.push({
        id: event.id,
        content: event.content,
        created_at: event.created_at
      });
      // Optional: To keep pubkeyActivity from growing indefinitely with very old events not relevant
      // to time-windowed checks, a pruning mechanism could be added here.
      // For example, userEventHistory.sort((a,b) => a.created_at - b.created_at);
      // then, find index of first event within max_time_window_needed and slice.
    }
    console.log(`Spam detection complete. Found ${identifiedSpamEvents.size} potential spam events.`);
    return Array.from(identifiedSpamEvents.values());

  } catch (error) {
    console.error('Error during spam detection:', error);
    // Ensure SPAM_EVENTS_FILE is empty in case of error partway through processing
    try {
        await fs.writeFile(SPAM_EVENTS_FILE, '');
        console.log(`Cleared ${SPAM_EVENTS_FILE} due to error during detection.`);
    } catch (e) { /* ignore cleanup error */ }
    return []; // Return empty array on error
  }
}

async function reportSpamExamples(limit = 10) {
  console.log(`
--- Reporting up to ${limit} Spam Event Examples from ${SPAM_EVENTS_FILE} ---`);
  let reportedCount = 0;
  try {
    const fileContent = await fs.readFile(SPAM_EVENTS_FILE, 'utf-8');
    const lines = fileContent.split('\n').filter(line => line.trim() !== '');

    if (lines.length === 0) {
      console.log('No spam events found in spam.jsonl to report.');
      return;
    }

    for (const line of lines) {
      if (reportedCount >= limit) {
        console.log(`\nDisplayed first ${limit} spam events. More may be in ${SPAM_EVENTS_FILE}.`);
        break;
      }
      const event = JSON.parse(line);

      console.log(`
[Spam Example ${reportedCount + 1}]`);
      console.log(`  ID: ${event.id}`);
      console.log(`  Pubkey: ${event.pubkey.substring(0, 8)}...${event.pubkey.substring(event.pubkey.length - 4)}`);
      console.log(`  Created At: ${new Date(event.created_at * 1000).toISOString()}`);
      console.log(`  Content Snippet: "${event.content.substring(0, 100)}${event.content.length > 100 ? '...' : ''}"`);
      console.log(`  Reasons Flagged:`);
      if (event.spamReasons && event.spamReasons.length > 0) {
        event.spamReasons.forEach(reason => console.log(`    - ${reason}`));
      } else {
        // This case should ideally not be hit if spamReason is always populated by detectSpam
        console.log(`    - No specific reasons recorded.`);
      }
      reportedCount++;
    }
    if (reportedCount === 0 && lines.length > 0) {
        console.log('No spam events were processed for reporting, though spam.jsonl was not empty. Check parsing or logic.');
    } else if (reportedCount > 0 && reportedCount < lines.length && reportedCount == limit) {
        // Covered by the message inside the loop if limit is reached.
    } else if (reportedCount > 0 && reportedCount < limit) {
        console.log(`\nDisplayed all ${reportedCount} spam events found in ${SPAM_EVENTS_FILE}.`)
    }


  } catch (error) {
    if (error.code === 'ENOENT') {
        console.log(`${SPAM_EVENTS_FILE} not found. Run spam detection first.`);
    } else {
        console.error('Error during spam reporting:', error);
    }
  }
}

(async () => {
  console.log('Attempting to connect to relay...');
  const relay = await connectToRelay(RELAY_URL);
  // let allFetchedEvents = []; // This variable is not directly used to gate spam detection anymore

  if (relay) {
    try {
      console.log('Relay object obtained. Starting paginated event fetching...');
      /*allFetchedEvents = */ await fetchPaginatedEvents(relay); // Result not strictly needed here
      // console.log(`Successfully fetched ${allFetchedEvents.length} unique events to ${RAW_EVENTS_FILE}.`);
    } catch (error) {
      console.error('An error occurred during event fetching:', error);
    } finally {
      if (relay && (relay.status === WebSocket.OPEN || relay.status === WebSocket.CONNECTING)) {
        console.log('Closing relay connection.');
        await relay.close();
      } else if (relay) {
        console.log(`Relay status: ${relay.status}. Not attempting to close.`);
      }
    }
  } else {
    console.log('Could not establish relay connection.');
  }

  // Determine if raw events were fetched by checking RAW_EVENTS_FILE
  let rawEventsExist = false;
  try {
    const stats = await fs.stat(RAW_EVENTS_FILE);
    if (stats.size > 0) { // Check if file has content
        rawEventsExist = true;
    } else {
        console.log(`${RAW_EVENTS_FILE} is empty. Skipping spam detection and reporting.`);
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
        console.log(`${RAW_EVENTS_FILE} not found. Skipping spam detection and reporting.`);
    } else {
        console.error(`Error checking ${RAW_EVENTS_FILE}:`, error);
    }
  }

  if (rawEventsExist) {
    await detectSpam();
    await reportSpamExamples(10);
  } else {
    // Ensure spam.jsonl is empty if no raw events processed
    try {
        await fs.writeFile(SPAM_EVENTS_FILE, '');
        console.log(`Initialized empty ${SPAM_EVENTS_FILE} as no raw events were processed.`);
    } catch (writeError) {
        console.error(`Error initializing empty ${SPAM_EVENTS_FILE}:`, writeError);
    }
  }

  console.log('Process finished.');
})();
