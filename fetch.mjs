import { SimplePool, useWebSocketImplementation } from 'nostr-tools/pool';
import WebSocket from 'ws'; // Ensure ws is installed, nostr-tools might use it
import fs from 'fs/promises';
import path from 'path';
import { SPAM_EVENTS_FILE, spamConstants, analyzeEventForSpam } from './lib/spamUtils.mjs';

const RELAY_URL = 'wss://relay.damus.io';
const RAW_EVENTS_FILE = 'raw.jsonl'; // Keep this here or in a general constants file

// Initialize WebSocket support for Node.js
useWebSocketImplementation(WebSocket);

// connectToRelay function (modified to use SimplePool)
async function connectToRelay(url) {
  // SimplePool doesn't require an explicit connect call for individual relays.
  // It manages connections internally when you subscribe or query.
  // We return a new pool instance. The URL is used when subscribing/querying.
  console.log(`Relay URL for operations: ${url}`);
  return new SimplePool();
}

// fetchPaginatedEvents function (modified for SimplePool)
async function fetchPaginatedEvents(pool, relayUrl) {
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
    console.log(`Fetching events with filter:`, filter);
    let eventsInBatch = []; // Ensure eventsInBatch is fresh for each iteration
    let subCloser = null;

    await new Promise((resolve, reject) => {
      const eoseTimeout = setTimeout(() => {
        console.warn(`Timeout waiting for EOSE for filter:`, filter);
        if (subCloser) {
          subCloser.close(); // Close the subscription
        }
        resolve(); // Resolve to allow the loop to potentially break or continue
      }, 30000); // 30 seconds timeout

      const oneventCallback = (event) => {
        if (!uniqueEvents.has(event.id)) {
          uniqueEvents.set(event.id, event);
          eventsInBatch.push(event);
          totalFetched++;
          try {
            const eventString = JSON.stringify(event);
            fs.appendFile(RAW_EVENTS_FILE, eventString + '\n').catch(err => {
              console.error(`Error appending event ${event.id} to ${RAW_EVENTS_FILE}:`, err);
            });
          } catch (err) {
            console.error(`Immediate error appending event ${event.id} to ${RAW_EVENTS_FILE}:`, err);
          }
        } // Closes the if block
      }; // Closes the oneventCallback function assignment

      const oneoseCallback = () => {
        clearTimeout(eoseTimeout);
        console.log(`EOSE received for until=${currentUntil}. Batch size: ${eventsInBatch.length}, Total unique: ${totalFetched}`);
        resolve();
      };

      const oncloseCallback = (reason) => {
        clearTimeout(eoseTimeout);
        console.log(`Subscription closed for filter:`, filter, `Reason: ${reason}`);
        resolve();
      };

      subCloser = pool.subscribe(
        [relayUrl],
        filter, // Pass the filter object directly
        {
          onevent: oneventCallback,
          oneose: oneoseCallback,
          onclose: oncloseCallback
        }
      );
    });

    if (eventsInBatch.length === 0) {
      console.log('No new unique events received in this batch. Stopping pagination.');
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
  const identifiedSpamEvents = new Map();

  try {
    try {
      await fs.access(RAW_EVENTS_FILE);
    } catch (e) {
      console.log(`${RAW_EVENTS_FILE} not found by detectSpam. Skipping.`);
      await fs.writeFile(SPAM_EVENTS_FILE, '');
      console.log(`Initialized ${SPAM_EVENTS_FILE} as empty.`);
      return [];
    }

    const fileContent = await fs.readFile(RAW_EVENTS_FILE, 'utf-8');
    const lines = fileContent.split('\n').filter(line => line.trim() !== '');

    if (lines.length === 0) {
        console.log(`${RAW_EVENTS_FILE} is empty. Skipping spam detection.`);
        await fs.writeFile(SPAM_EVENTS_FILE, '');
        console.log(`Initialized ${SPAM_EVENTS_FILE} as empty.`);
        return [];
    }

    await fs.writeFile(SPAM_EVENTS_FILE, '');
    console.log(`Initialized ${SPAM_EVENTS_FILE}`);

    const pubkeyActivity = {};

    for (const line of lines) {
      const event = JSON.parse(line);
      if (!pubkeyActivity[event.pubkey]) {
        pubkeyActivity[event.pubkey] = [];
      }
      const userEventHistory = pubkeyActivity[event.pubkey];
      const reasons = analyzeEventForSpam(event, userEventHistory, spamConstants);

      if (reasons.length > 0) {
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
      userEventHistory.push({
        id: event.id,
        content: event.content,
        created_at: event.created_at
      });
    }
    console.log(`Spam detection complete. Found ${identifiedSpamEvents.size} potential spam events.`);
    return Array.from(identifiedSpamEvents.values());

  } catch (error) {
    console.error('Error during spam detection:', error);
    try {
        await fs.writeFile(SPAM_EVENTS_FILE, '');
        console.log(`Cleared ${SPAM_EVENTS_FILE} due to error during detection.`);
    } catch (e) { /* ignore cleanup error */ }
    return [];
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
  console.log('Attempting to connect to relay using SimplePool...');
  const pool = await connectToRelay(RELAY_URL);

  if (pool) {
    try {
      console.log('SimplePool instance obtained. Starting paginated event fetching...');
      await fetchPaginatedEvents(pool, RELAY_URL);
    } catch (error) {
      console.error('An error occurred during event fetching:', error);
    } finally {
      console.log('Closing connections in SimplePool.');
      pool.close([RELAY_URL]);
    }
  } else {
    console.log('Could not initialize SimplePool.');
  }

  let rawEventsExist = false;
  try {
    const stats = await fs.stat(RAW_EVENTS_FILE);
    if (stats.size > 0) {
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
    try {
        await fs.writeFile(SPAM_EVENTS_FILE, '');
        console.log(`Initialized empty ${SPAM_EVENTS_FILE} as no raw events were processed.`);
    } catch (writeError) {
        console.error(`Error initializing empty ${SPAM_EVENTS_FILE}:`, writeError);
    }
  }

  console.log('Process finished.');
})();
