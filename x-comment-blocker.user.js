// ==UserScript==
// @name         X(Twitter) Comment Blocker Lite
// @namespace    http://tampermonkey.net/
// @version      1.4.3
// @description  一键净化 X (Twitter) 评论区，自动屏蔽垃圾信息与引流机器人。
// @author       amahteru
// @license      MIT
// @match        *://x.com/*
// @match        *://twitter.com/*
// @run-at       document-idle
// @icon         https://www.google.com/s2/favicons?sz=64&domain=x.com
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.xmlHttpRequest
// @connect      fastly.jsdelivr.net
// ==/UserScript==

(function() {
    'use strict';

    const CLOUD_KEYWORDS_CDN = 'https://fastly.jsdelivr.net/gh/amahteru/x-comment-blocker@main/keywords.txt';
    const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
    const STORAGE_KEY_KEYWORDS = 'x_cb_cloud_keywords';
    const STORAGE_KEY_LAST_SYNC = 'x_cb_last_sync_time';

    const invisibleCharsRegex = /\p{Default_Ignorable_Code_Point}/gu;
    let blockRegexes = [];
    let blocklistVersion = 0;
    let isSyncing = false;

    function getStoredKeywords() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY_KEYWORDS);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed) && parsed.length > 0) return parsed;
            }
        } catch (e) {}

        return [];
    }

    function saveStoredKeywords(keywords) {
        if (!Array.isArray(keywords) || keywords.length === 0) return;
        try {
            if (typeof GM !== 'undefined' && typeof GM.setValue === 'function') {
                GM.setValue('cloudKeywords', keywords).catch(() => {});
            }
        } catch (e) {}

        try {
            localStorage.setItem(STORAGE_KEY_KEYWORDS, JSON.stringify(keywords));
            localStorage.setItem(STORAGE_KEY_LAST_SYNC, Date.now().toString());
        } catch (e) {}
    }

    function getLastSyncTime() {
        try {
            const t = localStorage.getItem(STORAGE_KEY_LAST_SYNC);
            if (t) return parseInt(t, 10) || 0;
        } catch (e) {}

        return 0;
    }

    function isKeywordRegex(k) {
        return typeof k === 'string' && k.length >= 3 && /^\/.+\/[a-zA-Z]*$/.test(k);
    }

    const categoryHeaderRegex = /^#(?:\s*\[(?<bracketName>[^\]]+)\]|\s+(?<spaceName>\S+.*))$/;

    function isCategoryHeader(line) {
        if (typeof line !== 'string') return false;
        const cleaned = line.replaceAll(invisibleCharsRegex, '').trim();
        return categoryHeaderRegex.test(cleaned);
    }

    function parseKeywords(text) {
        if (!text) return [];
        const result = [];
        for (const line of text.split('\n')) {
            const k = line.replaceAll(invisibleCharsRegex, '').trim();
            if (!k || k === '#' || isCategoryHeader(k)) continue;
            if (isKeywordRegex(k)) {
                result.push(k);
            } else {
                result.push(k.toLowerCase());
            }
        }
        return result;
    }

    function buildTrieRegex(plainKeywords) {
        if (!plainKeywords?.length) return null;
        const seen = new Set();
        const MAX_KEYWORD_LENGTH = 1000;
        for (const kw of plainKeywords) {
            if (typeof kw !== 'string') continue;
            const cleaned = kw.trim().toLowerCase();
            if (cleaned && cleaned.length <= MAX_KEYWORD_LENGTH) seen.add(cleaned);
        }
        if (!seen.size) return null;
        const sorted = Array.from(seen).sort((a, b) => a.length - b.length);

        const pruned = [];
        for (const kw of sorted) {
            if (!pruned.some((p) => kw.includes(p))) pruned.push(kw);
        }

        const root = {};
        for (const kw of pruned) {
            let node = root;
            for (const ch of kw) {
                node = node[ch] ??= {};
            }
        }

        const escapeChar = (c) => (/[.*+?^${}()|[\]\\]/.test(c) ? `\\${c}` : c);
        function stringify(node) {
            const keys = Object.keys(node);
            if (!keys.length) return '';
            const branches = keys.map((k) => escapeChar(k) + stringify(node[k]));
            return branches.length > 1 ? `(?:${branches.join('|')})` : branches[0];
        }

        return new RegExp(stringify(root), 'iu');
    }

    function buildRegexes(keywords) {
        if (!Array.isArray(keywords) || keywords.length === 0) return [];
        const plainKeywords = [];
        const customRegexes = [];

        for (const kw of keywords) {
            if (typeof kw !== 'string') continue;
            const match = kw.startsWith('/')
                ? kw.match(/^\/(?<pattern>.+)\/(?<flags>[a-zA-Z]*)$/)
                : null;
            if (match) {
                try {
                    const cleanFlags = match.groups.flags.replace(/[gy]/g, '');
                    customRegexes.push(new RegExp(match.groups.pattern, cleanFlags));
                } catch (e) {
                    console.warn('[X-Blocker] Invalid regex ignored:', kw, e);
                }
            } else {
                plainKeywords.push(kw);
            }
        }

        const regexes = [];
        if (plainKeywords.length > 0) {
            const trieRegex = buildTrieRegex(plainKeywords);
            if (trieRegex) regexes.push(trieRegex);
        }
        if (customRegexes.length > 0) {
            regexes.push(...customRegexes);
        }
        return regexes;
    }

    let initialKeywords = getStoredKeywords();
    blockRegexes = buildRegexes(initialKeywords);

    if (blockRegexes.length === 0 && typeof GM !== 'undefined' && typeof GM.getValue === 'function') {
        GM.getValue('cloudKeywords', []).then(kw => {
            if (Array.isArray(kw) && kw.length > 0) {
                blockRegexes = buildRegexes(kw);
                blocklistVersion++;
                filterTweets();
            }
        }).catch(() => {});
    }

    function handleKeywordsResponse(responseText) {
        const keywords = parseKeywords(responseText);
        if (keywords.length > 0) {
            saveStoredKeywords(keywords);
            blockRegexes = buildRegexes(keywords);
            blocklistVersion++;
            console.log(`[X-Blocker] Cloud keywords synced: ${keywords.length} items.`);
            filterTweets();
        }
    }

    function syncCloudKeywords() {
        if (isSyncing) return;
        const lastSyncTime = getLastSyncTime();
        if (Date.now() - lastSyncTime < SYNC_INTERVAL_MS && blockRegexes.length > 0) {
            return;
        }

        if (typeof GM === 'undefined' || typeof GM.xmlHttpRequest !== 'function') {
            return;
        }

        isSyncing = true;
        const url = `${CLOUD_KEYWORDS_CDN}?t=${Date.now()}`;

        try {
            GM.xmlHttpRequest({
                method: 'GET',
                url: url,
                onload: function(response) {
                    isSyncing = false;
                    if (response && response.status === 200 && response.responseText) {
                        handleKeywordsResponse(response.responseText);
                    }
                },
                onerror: function() {
                    isSyncing = false;
                },
                ontimeout: function() {
                    isSyncing = false;
                },
                onabort: function() {
                    isSyncing = false;
                }
            });
        } catch (e) {
            isSyncing = false;
        }
    }

    function matchesBlocklist(text) {
        if (blockRegexes.length === 0 || !text) return false;
        return blockRegexes.some((regex) => regex.test(text));
    }

    function getTweetTextForKeywords(node) {
        if (!node) return '';
        let text = '';
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
        let currentNode = walker.currentNode;
        while (currentNode) {
            if (currentNode.nodeType === Node.TEXT_NODE) {
                text += currentNode.textContent;
            } else if (currentNode.nodeType === Node.ELEMENT_NODE) {
                const tagName = currentNode.tagName.toLowerCase();
                if (['br', 'div', 'p'].includes(tagName)) {
                    if (text && !text.endsWith('\n')) text += '\n';
                } else if (tagName === 'img' && currentNode.alt) {
                    let altText = currentNode.alt;
                    if (
                        currentNode.src &&
                        (currentNode.src.includes('emoji') || currentNode.src.includes('twemoji')) &&
                        !altText.endsWith('\uFE0F')
                    ) {
                        if (altText.length <= 2) {
                            altText += '\uFE0F';
                        }
                    }
                    text += altText;
                }
            }
            currentNode = walker.nextNode();
        }
        return text;
    }

    function getPageContext() {
        const urlMatch = window.location.pathname.match(/\/status\/(\d+)/i);
        return {
            pageStatusId: urlMatch ? urlMatch[1] : null,
            isPhotoVideoOverlay: /\/status\/\d+\/(?:photo|video)\//i.test(window.location.pathname),
        };
    }

    function resolveStatusPage(tweet, pageContext) {
        if (pageContext.isPhotoVideoOverlay) {
            return tweet.closest('[role="dialog"]') !== null;
        }
        return !!pageContext.pageStatusId;
    }
    
    const fastHandleRegex = /^[@/]?([a-zA-Z0-9_]{1,15})$/;
    function extractCleanScreenName(input) {
      if (!input) return '';
      const simpleMatch = fastHandleRegex.exec(input);
      if (simpleMatch) return simpleMatch[1].toLowerCase();
      const cleaned = input.replaceAll(invisibleCharsRegex, '').trim();
      const match = cleaned.match(/(?:^|\/|@)(?<handle>[a-zA-Z0-9_]{1,15})(?:\/|\?|$)/);
      return match ? match.groups.handle.toLowerCase() : '';
    }

    function hasGrokCard(tweet) {
        if (!tweet) return false;
        return !!tweet.querySelector('a[href*="/i/grok/share"], meta[content*="/i/grok/share"]');
    }

    function detectSpam(tweet, rawTweetText, rawUserName, userNode) {
        if (hasGrokCard(tweet)) return true;

        const tweetBody = rawTweetText ? rawTweetText.replaceAll(invisibleCharsRegex, '') : '';
        
        let stableHandle = '';
        const handleLink = userNode?.querySelector('a[href^="/"]');
        if (handleLink) {
            const rawHref = handleLink.getAttribute('href') || '';
            stableHandle = extractCleanScreenName(rawHref);
        }

        const userName = rawUserName ? rawUserName.replaceAll(invisibleCharsRegex, '') : '';
        const cleanUserName = userName
            ? userName.replaceAll(/[\s_.\-]+/g, '')
            : '';

        if (
            matchesBlocklist(tweetBody) ||
            (cleanUserName && matchesBlocklist(cleanUserName)) ||
            (userName && matchesBlocklist(userName)) ||
            (stableHandle && matchesBlocklist(stableHandle))
        ) {
            return true;
        }
        return false;
    }

    const tweetStateMap = new WeakMap();

    function filterTweets(specificTweets = null) {
        const tweets = specificTweets || document.querySelectorAll('[data-testid="cellInnerDiv"]');
        if (!tweets || tweets.length === 0) return;

        const pageContext = getPageContext();

        for (const tweet of tweets) {
            const isStatusPage = resolveStatusPage(tweet, pageContext);
            if (!isStatusPage) continue;
            
            const timeEl = tweet.querySelector('time');
            const href = timeEl?.closest('a')?.getAttribute('href');
            const match = href?.match(/\/status\/(\d+)/i);
            const isMainTweet = match && match[1] === pageContext.pageStatusId;
            if (isMainTweet && tweet.querySelector('article')) {
               continue;
            }

            if (tweet.closest('[aria-hidden="true"]')) continue;

            const userNode = tweet.querySelector('[data-testid="User-Name"]');
            const textNode = tweet.querySelector('[data-testid="tweetText"]');

            const rawTweetText = textNode ? getTweetTextForKeywords(textNode) : '';
            const rawUserName = userNode ? getTweetTextForKeywords(userNode) : '';
            
            const prev = tweet.previousElementSibling;
            const prevHidden = prev && (prev.dataset.xCbHidden === 'true' || prev.dataset.xCbHiddenReply === 'true');

            const quickHash = `${blocklistVersion}|${rawTweetText}|${rawUserName}|${prevHidden}`;

            let state = tweetStateMap.get(tweet);
            if (!state) {
                state = {};
                tweetStateMap.set(tweet, state);
            }

            if (state.quickHash !== quickHash) {
                state.quickHash = quickHash;
                state.isSpam = detectSpam(tweet, rawTweetText, rawUserName, userNode);

                let isHiddenReply = false;
                if (!state.isSpam && prevHidden) {
                    const hasThreadLine = !!tweet.querySelector('div[style*="width: 2px"]') || !!tweet.querySelector('[class*="r-1d2f490"]');
                    const hasReplyingTo = !!tweet.querySelector('div[dir="ltr"] a[href^="/"]');
                    if (hasThreadLine || hasReplyingTo) {
                        isHiddenReply = true;
                    }
                }
                state.isHiddenReply = isHiddenReply;

                if (state.isSpam) {
                    tweet.style.display = 'none';
                    tweet.dataset.xCbHidden = 'true';
                    delete tweet.dataset.xCbHiddenReply;
                } else if (state.isHiddenReply) {
                    tweet.style.display = 'none';
                    tweet.dataset.xCbHiddenReply = 'true';
                    delete tweet.dataset.xCbHidden;
                } else {
                    tweet.style.display = '';
                    delete tweet.dataset.xCbHidden;
                    delete tweet.dataset.xCbHiddenReply;
                }
            }
        }
    }

    let observerFlushScheduled = false;
    const pendingTweets = new Set();

    function getEnclosingTweetIfRelevant(target) {
        let curr = target?.nodeType === Node.ELEMENT_NODE ? target : target?.parentElement;
        let isRelevant = false;
        while (curr && curr !== document.body) {
            const testId = curr.getAttribute('data-testid');
            if (testId === 'tweetText' || testId === 'User-Name') {
                isRelevant = true;
            } else if (testId === 'cellInnerDiv') {
                return isRelevant ? curr : null;
            }
            curr = curr.parentElement;
        }
        return null;
    }

    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType !== Node.ELEMENT_NODE) continue;
                if (node.getAttribute('data-testid') === 'cellInnerDiv') {
                    pendingTweets.add(node);
                } else if (node.firstElementChild) {
                    for (const inner of node.querySelectorAll('[data-testid="cellInnerDiv"]')) {
                        pendingTweets.add(inner);
                    }
                }
            }

            const tweet = getEnclosingTweetIfRelevant(mutation.target);
            if (tweet) {
                pendingTweets.add(tweet);
            }
        }

        if (pendingTweets.size > 0 && !observerFlushScheduled) {
            observerFlushScheduled = true;
            queueMicrotask(() => {
                observerFlushScheduled = false;
                if (pendingTweets.size > 0) {
                    const orderedTweets = Array.from(pendingTweets).sort((a, b) => {
                        return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
                    });
                    filterTweets(orderedTweets);
                    pendingTweets.clear();
                }
            });
        }
    });

    function initObserver() {
        const targetNode = document.body || document.documentElement;
        observer.observe(targetNode, {
            childList: true,
            subtree: true,
        });
        filterTweets();
    }

    window.addEventListener('pageshow', () => {
        filterTweets();
        syncCloudKeywords();
    });
    window.addEventListener('popstate', () => {
        setTimeout(filterTweets, 50);
    });

    initObserver();
    syncCloudKeywords();
})();
