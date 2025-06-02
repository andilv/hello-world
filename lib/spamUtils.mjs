// lib/spamUtils.mjs
export const SPAM_EVENTS_FILE = 'spam.jsonl';

export const spamConstants = {
  repetitiveContent: {
    timeWindowSeconds: 5 * 60, // 5 minutes
  },
  rapidFire: {
    // For "Rapid fire posts (X posts in Ys)", X is postCountThreshold, Y is timeWindowSeconds
    // The check should be: if count of posts in last Y seconds >= (postCountThreshold - 1), then current post makes it spam.
    postCountThreshold: 3,
    timeWindowSeconds: 10,
  },
  keywords: ['onlyfans', 'crypto giveaway', 'free money', 'adult dating', 'buy followers', '100x gem'],
  excessiveTags: {
    tagThreshold: 5,
    contentLengthThreshold: 100, // Content length under which tag check applies more strictly
    // Ratio: text length / (tag count + 1). Lower ratio means more tags for the amount of text.
    tagToContentRatioThreshold: 10,
  },
  lowAlphanumeric: {
    ratioThreshold: 0.4, // Less than 40% alphanumeric characters
    minLengthContent: 10, // Minimum content length to apply this check
  },
  gibberish: {
    commonWordList: [ // A small, illustrative list. A real one would be larger or from a file.
      'the', 'be', 'to', 'of', 'and', 'a', 'in', 'that', 'have', 'i', 'it', 'for', 'not', 'on', 'with', 'he', 'as', 'you', 'do', 'at',
      'this', 'but', 'his', 'by', 'from', 'they', 'we', 'say', 'her', 'she', 'or', 'an', 'will', 'my', 'one', 'all', 'would', 'there', 'their', 'what',
      'so', 'up', 'out', 'if', 'about', 'who', 'get', 'which', 'go', 'me', 'when', 'make', 'can', 'like', 'time', 'no', 'just', 'him', 'know', 'take',
      'people', 'into', 'year', 'your', 'good', 'some', 'could', 'them', 'see', 'other', 'than', 'then', 'now', 'look', 'only', 'come', 'its', 'over',
      'think', 'also', 'back', 'after', 'use', 'two', 'how', 'our', 'work', 'first', 'well', 'way', 'even', 'new', 'want', 'because', 'any', 'these', 'give', 'day', 'most', 'us'
    ],
    unrecognizedWordRatioThreshold: 0.7, // If >70% of words are not in commonWordList (and > minWordCount)
    minWordCountForUnrecognizedRatio: 5, // Min words in content to apply unrecognizedWordRatio check
    avgWordLengthMaxThreshold: 20,      // Max average word length
    avgWordLengthMinThreshold: 2.0,     // Min average word length (for very short word spam) - less common
    maxConsecutiveCharsThreshold: 4,    // e.g., "aaaaa" (5) would be flagged
    minWordLengthForRepetitionCheck: 3,
    maxRepetitiveWordsThreshold: 2,     // e.g., "spam spam spam" (3) would be flagged
    vowelToConsonantRatioRange: [0.2, 0.7], // Acceptable range for (vowels / (consonants || 1))
    minWordLengthForVowelRatioCheck: 4, // Min word length to check vowel ratio
    minNonSpaceCharsForGibberishCheck: 20 // Min number of non-space characters to run gibberish checks
  }
};

/**
 * Checks for repetitive content from the same user within a given time window.
 * @param {object} currentEvent The event being checked.
 * @param {array} userEventHistory Array of previous events from the same user [{content, created_at, id}, ...].
 * @param {object} config Configuration { timeWindowSeconds }.
 * @returns {string|null} Reason string if spam, else null.
 */
export function checkRepetitiveContent(currentEvent, userEventHistory, config) {
  const earliestTimeToConsider = currentEvent.created_at - config.timeWindowSeconds;
  for (let i = userEventHistory.length - 1; i >= 0; i--) {
    const prevEvent = userEventHistory[i];
    if (prevEvent.created_at < earliestTimeToConsider) break; // Stop checking older events
    // Ensure we are not comparing the event with itself if history includes currentEvent
    if (prevEvent.id === currentEvent.id) continue;
    if (prevEvent.content === currentEvent.content) {
      return `Repetitive content (exact match of event ${prevEvent.id} within ${config.timeWindowSeconds / 60} mins)`;
    }
  }
  return null;
}

/**
 * Checks for rapid fire posts from the same user.
 * @param {object} currentEvent The event being checked.
 * @param {array} userEventHistory Array of previous events from the same user [{content, created_at, id}, ...].
 * @param {object} config Configuration { postCountThreshold, timeWindowSeconds }.
 * @returns {string|null} Reason string if spam, else null.
 */
export function checkRapidFire(currentEvent, userEventHistory, config) {
  const timeWindowStart = currentEvent.created_at - config.timeWindowSeconds;
  let recentPostCount = 0; // Counts *previous* posts in window for currentEvent
  userEventHistory.forEach(prevEvent => {
    // Ensure we are not comparing the event with itself
    if (prevEvent.id === currentEvent.id) return;
    // Count posts strictly *before* the current event's timestamp for this check
    if (prevEvent.created_at > timeWindowStart && prevEvent.created_at < currentEvent.created_at) {
      recentPostCount++;
    }
  });

  // The current event is one more post.
  // So, if recentPostCount (previous posts) is already config.postCountThreshold - 1, this event makes it meet/exceed the threshold.
  if (recentPostCount + 1 >= config.postCountThreshold) {
    return `Rapid fire posts (${recentPostCount + 1} posts in ${config.timeWindowSeconds}s)`;
  }
  return null;
}

/**
 * Checks if event content contains spam keywords.
 * @param {string} eventContent The content of the event.
 * @param {array} keywordListConfig Array of spam keywords.
 * @returns {string|null} Reason string if spam, else null.
 */
export function checkSpamKeywords(eventContent, keywordListConfig) {
  const lowerContent = eventContent.toLowerCase();
  for (const keyword of keywordListConfig) {
    if (lowerContent.includes(keyword.toLowerCase())) { // Ensure keyword matching is also case-insensitive
      return `Contains spam keyword: "${keyword}"`;
    }
  }
  return null;
}

/**
 * Checks for excessive mentions or hashtags in short messages.
 * @param {string} eventContent The content of the event.
 * @param {object} config Configuration { tagThreshold, contentLengthThreshold, tagToContentRatioThreshold }.
 * @returns {string|null} Reason string if spam, else null.
 */
export function checkExcessiveTags(eventContent, config) {
  const tagCount = (eventContent.match(/#/g) || []).length + (eventContent.match(/@/g) || []).length;
  if (eventContent.length < config.contentLengthThreshold && tagCount > config.tagThreshold) {
    // Check ratio: content length per tag. Lower means more "dense" with tags.
    // Avoid division by zero if tagCount is 0, though caught by tagThreshold > 0
    if ((tagCount > 0) && (eventContent.length / tagCount) < config.tagToContentRatioThreshold) {
       return `Excessive tags (${tagCount}) in short message (length ${eventContent.length})`;
    }
  }
  return null;
}

/**
 * Checks if content has a low alphanumeric character ratio.
 * @param {string} eventContent The content of the event.
 * @param {object} config Configuration { ratioThreshold, minLengthContent }.
 * @returns {string|null} Reason string if spam, else null.
 */
export function checkLowAlphanumericRatio(eventContent, config) {
  if (eventContent.length < config.minLengthContent) return null; // Don't check very short strings

  const alphanumericChars = eventContent.match(/[a-z0-9]/gi) || [];
  // Handle division by zero for empty content, though minLengthContent should prevent it.
  const ratio = eventContent.length > 0 ? alphanumericChars.length / eventContent.length : 0;
  if (ratio < config.ratioThreshold) {
    return `Low alphanumeric content ratio (${(ratio * 100).toFixed(1)}%)`;
  }
  return null;
}

/**
 * Analyzes an event for various spam characteristics.
 * @param {object} event The event object to analyze. Must include `id`, `pubkey`, `created_at`, `content`.
 * @param {array} userEventHistory Array of previous events from the same pubkey [{content, created_at, id}, ...].
 *                                This history should be managed by the caller and ideally not include the current event.
 * @param {object} config The spamConstants configuration object.
 * @returns {array} An array of reason strings. Empty if not spam, otherwise contains reasons.
 */
export function analyzeEventForSpam(event, userEventHistory, config) {
  const reasons = [];
  let reason;

  // Check 1: Repetitive Content
  // For repetitive content, userEventHistory should contain events *before* the current one.
  reason = checkRepetitiveContent(event, userEventHistory, config.repetitiveContent);
  if (reason) reasons.push(reason);

  // Check 2: Rapid Fire Posts
  // userEventHistory for checkRapidFire should also ideally contain events *before* currentEvent.
  reason = checkRapidFire(event, userEventHistory, config.rapidFire);
  if (reason) reasons.push(reason);

  // Check 3: Specific Spam Keywords
  reason = checkSpamKeywords(event.content, config.keywords);
  if (reason) reasons.push(reason);

  // Check 4: Excessive Mentions/Hashtags
  reason = checkExcessiveTags(event.content, config.excessiveTags);
  if (reason) reasons.push(reason);

  // Check 5: Content mainly non-alphanumeric or excessive emojis
  reason = checkLowAlphanumericRatio(event.content, config.lowAlphanumeric);
  if (reason) reasons.push(reason);

  // New Check 6: Gibberish Content
  reason = checkGibberishContent(event.content, config.gibberish); // Ensure 'gibberish' key exists in config
  if (reason) reasons.push(reason);

  return reasons;
}

/**
 * Checks if event content is likely gibberish.
 * @param {string} eventContent The content of the event.
 * @param {object} gibberishConfig Configuration from spamConstants.gibberish.
 * @returns {string|null} Reason string if spam, else null.
 */
export function checkGibberishContent(eventContent, gibberishConfig) {
  const content = eventContent.trim();
  const nonSpaceChars = content.replace(/\s+/g, '');

  if (nonSpaceChars.length < gibberishConfig.minNonSpaceCharsForGibberishCheck) {
    return null; // Too short to reliably determine as gibberish
  }

  // 1. Consecutive Characters Check (e.g., "aaaaa", "!!!!!!")
  // Regex: (any_char)\1{N,} where N is maxConsecutiveCharsThreshold. So, N+1 or more repetitions.
  const consecutiveCharRegex = new RegExp(`(.)\\1{${gibberishConfig.maxConsecutiveCharsThreshold}}`, 'g');
  if (consecutiveCharRegex.test(content)) {
    return `Contains ${gibberishConfig.maxConsecutiveCharsThreshold + 1}+ consecutive identical characters.`;
  }

  const words = content.toLowerCase().split(/\s+/).filter(w => w.length > 0);
  if (words.length === 0) {
    return null; // No words to analyze (e.g. content was only symbols removed by split)
  }

  // 2. Average Word Length Check
  const totalWordLength = words.reduce((sum, word) => sum + word.length, 0);
  const avgWordLen = totalWordLength / words.length;
  if (avgWordLen > gibberishConfig.avgWordLengthMaxThreshold) {
    return `Average word length (${avgWordLen.toFixed(1)}) exceeds threshold (${gibberishConfig.avgWordLengthMaxThreshold}).`;
  }
  // Not checking min avg word length for now, as it's less common for spam and might have false positives.

  // 3. Repetitive Word Patterns (e.g., "spam spam spam")
  let repetitiveWordCount = 0;
  let lastWord = '';
  for (const word of words) {
    if (word.length >= gibberishConfig.minWordLengthForRepetitionCheck) {
      if (word === lastWord) {
        repetitiveWordCount++;
      } else {
        repetitiveWordCount = 1; // Reset for new word
        lastWord = word;
      }
      // maxRepetitiveWordsThreshold means how many times a word can appear consecutively.
      // So, "word word word" is 3 repetitions. If threshold is 2, this is spam.
      if (repetitiveWordCount > gibberishConfig.maxRepetitiveWordsThreshold) {
        return `Excessive word repetition (word "${word}" repeated > ${gibberishConfig.maxRepetitiveWordsThreshold} times).`;
      }
    } else {
      // If word is too short, it doesn't count towards repetition but also resets the sequence.
      repetitiveWordCount = 0;
      lastWord = ''; // Reset lastWord as the sequence of longer words is broken.
    }
  }

  // 4. Lexical Coherence: Ratio of unrecognized words
  if (words.length >= gibberishConfig.minWordCountForUnrecognizedRatio) {
    const commonWordSet = new Set(gibberishConfig.commonWordList);
    // Only count words containing at least one letter as "unrecognized" to avoid penalizing symbol sequences.
    const unrecognizedWords = words.filter(word => word.match(/[a-z]/i) && !commonWordSet.has(word));
    const unrecognizedRatio = unrecognizedWords.length / words.length;
    if (unrecognizedRatio > gibberishConfig.unrecognizedWordRatioThreshold) {
      return `High ratio (${(unrecognizedRatio * 100).toFixed(0)}%) of words not in common dictionary.`;
    }
  }

  // 5. (Experimental) Vowel to Consonant Ratio in words (omitted as per plan)

  return null; // No definitive gibberish detected
}
