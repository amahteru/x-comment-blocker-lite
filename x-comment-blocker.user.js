// ==UserScript==
// @name         X(Twitter) Comment Blocker Lite
// @namespace    http://tampermonkey.net/
// @version      1.5.0
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
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      fastly.jsdelivr.net
// ==/UserScript==

(function() {
    'use strict';

    const gmGetValue = typeof GM !== 'undefined' && GM?.getValue ? GM.getValue.bind(GM) : (typeof GM_getValue !== 'undefined' ? (k, d) => Promise.resolve(GM_getValue(k, d)) : async (k, d) => d);
    const gmSetValue = typeof GM !== 'undefined' && GM?.setValue ? GM.setValue.bind(GM) : (typeof GM_setValue !== 'undefined' ? (k, v) => Promise.resolve(GM_setValue(k, v)) : async () => {});
    const gmXmlHttpRequest = typeof GM !== 'undefined' && GM?.xmlHttpRequest ? GM.xmlHttpRequest.bind(GM) : (typeof GM_xmlhttpRequest !== 'undefined' ? GM_xmlhttpRequest : null);

    const CLOUD_KEYWORDS_CDN = 'https://fastly.jsdelivr.net/gh/amahteru/x-comment-blocker@main/keywords.txt';
    const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
    const STORAGE_KEY_KEYWORDS = 'x_cb_cloud_keywords';
    const STORAGE_KEY_LAST_SYNC = 'x_cb_last_sync_time';

    const invisibleCharsRegex = /\p{Default_Ignorable_Code_Point}/gu;
    const hasInvisibleCharsRegex = /\p{Default_Ignorable_Code_Point}/u;
    const displayNamePunctRegex = /[\s_.\-]+/gu;
    const fastHandleRegex = /^[@\/]?(?<handle>[a-zA-Z0-9_]{1,15})$/u;
    const regexMetaCharRegex = /[.*+?^${}()|[\]\\]/u;
    const escapeChar = (c) => (regexMetaCharRegex.test(c) ? `\\${c}` : c);

    let blockRegexes = [];
    let blocklistVersion = 0;
    let isSyncing = false;
    const tweetStateMap = new WeakMap();

    function injectStyles() {
        if (document.getElementById('x-comment-blocker-style')) return;
        const style = document.createElement('style');
        style.id = 'x-comment-blocker-style';
        style.textContent = `
            .x-comment-blocker-hidden,
            .x-comment-blocker-hidden-reply {
                display: none !important;
            }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    function cleanInvisibleChars(str) {
        if (!str) return '';
        return hasInvisibleCharsRegex.test(str) ? str.replace(invisibleCharsRegex, '') : str;
    }

    function extractCleanScreenName(input) {
        if (!input) return '';
        const simpleMatch = fastHandleRegex.exec(input);
        if (simpleMatch) {
            return simpleMatch.groups.handle.toLowerCase();
        }
        const cleaned = cleanInvisibleChars(input).trim();
        const match = cleaned.match(/(?:^|\/|@)(?<handle>[a-zA-Z0-9_]{1,15})(?:\/|\?|$)/u);
        if (match) return match.groups.handle.toLowerCase();
        return '';
    }

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
        const now = Date.now().toString();
        try {
            gmSetValue(STORAGE_KEY_KEYWORDS, keywords).catch(() => {});
        } catch (e) {}

        try {
            localStorage.setItem(STORAGE_KEY_KEYWORDS, JSON.stringify(keywords));
            localStorage.setItem(STORAGE_KEY_LAST_SYNC, now);
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
        return typeof k === 'string' && k.length >= 3 && /^\/.+\/[a-zA-Z]*$/u.test(k);
    }

    function parseKeywords(text) {
        if (!text) return [];
        const result = [];
        for (const line of text.split('\n')) {
            const k = cleanInvisibleChars(line).trim();
            if (!k || k.startsWith('#')) continue;
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
                node = node[ch] || (node[ch] = {});
            }
        }

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
                ? kw.match(/^\/(?<pattern>.+)\/(?<flags>[a-zA-Z]*)$/u)
                : null;
            if (match) {
                try {
                    const cleanFlags = match.groups.flags.replace(/[gy]/gu, '');
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

    if (blockRegexes.length === 0) {
        gmGetValue(STORAGE_KEY_KEYWORDS, []).then(kw => {
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

        if (!gmXmlHttpRequest) {
            return;
        }

        isSyncing = true;
        const url = `${CLOUD_KEYWORDS_CDN}?t=${Date.now()}`;

        try {
            gmXmlHttpRequest({
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
                    text += currentNode.alt;
                }
            }
            currentNode = walker.nextNode();
        }
        return text;
    }

    function isMainTweetCell(tweet, pageStatusId) {
        if (!pageStatusId) return false;
        const timeElements = tweet.querySelectorAll('time');
        for (let i = 0; i < timeElements.length; i++) {
            const href = timeElements[i].closest('a')?.getAttribute('href');
            const match = href?.match(/\/status\/(\d+)/i);
            if (match && match[1] === pageStatusId) {
                return true;
            }
        }
        return false;
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
            if (tweet.closest('[role="dialog"]') !== null) return true;
            const state = tweetStateMap.get(tweet);
            if (state?.isStatusPage !== undefined) return state.isStatusPage;
            return false;
        }
        return !!pageContext.pageStatusId;
    }

    function getGrokShareElement(tweet) {
        if (!tweet) return null;
        return tweet.querySelector('a[href*="/i/grok/share"], meta[content*="/i/grok/share"]');
    }

    function matchesUserRegexes(displayName, cleanDisplayName, stableHandle, regexes) {
        if (!regexes.length) return false;
        for (let i = 0; i < regexes.length; i++) {
            const r = regexes[i];
            if (displayName && r.test(displayName)) return true;
            if (cleanDisplayName && cleanDisplayName !== displayName && r.test(cleanDisplayName))
                return true;
            if (stableHandle && (r.test(stableHandle) || r.test(`@${stableHandle}`))) {
                return true;
            }
        }
        return false;
    }

    function detectSpam(userNode, rawTweetText, grokElement = null) {
        if (grokElement) return true;

        const tweetBody = cleanInvisibleChars(rawTweetText);
        let stableHandle = '';
        let displayName = '';

        const handleLink = userNode?.querySelector('a[href^="/"]');
        if (handleLink) {
            const rawHref = handleLink.getAttribute('href') || '';
            stableHandle = extractCleanScreenName(rawHref);
            displayName = cleanInvisibleChars(getTweetTextForKeywords(handleLink)).trim();
        }

        const cleanDisplayName = displayName ? displayName.replace(displayNamePunctRegex, '') : '';

        if (matchesBlocklist(tweetBody)) {
            return true;
        }

        if (matchesUserRegexes(displayName, cleanDisplayName, stableHandle, blockRegexes)) {
            return true;
        }

        return false;
    }

    function isDiscoverMoreHeader(node) {
        if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
        if (node.querySelector('article')) return false;
        return !!node.querySelector('h2, [role="heading"]');
    }

    function isAfterDiscoverMore(tweet) {
        let curr = tweet.previousElementSibling;
        while (curr) {
            if (isDiscoverMoreHeader(curr)) return true;
            const prevState = tweetStateMap.get(curr);
            if (prevState?.isDiscoverMore !== undefined) {
                return prevState.isDiscoverMore;
            }
            curr = curr.previousElementSibling;
        }
        return false;
    }

    function getPreviousCell(tweet) {
        let curr = tweet.previousElementSibling;
        while (curr && !curr.querySelector('article, button, [role="button"]')) {
            curr = curr.previousElementSibling;
        }
        return curr;
    }

    function isReplyToParent(tweet, article) {
        if (!article) {
            const btn = tweet.querySelector('button, [role="button"]');
            return !!btn?.querySelector('.r-1bnu78o, .r-m5arl1, .r-epq5cr');
        }

        const avatar = tweet.querySelector('[data-testid="Tweet-User-Avatar"]');
        if (avatar) {
            const lines = tweet.querySelectorAll('.r-15zivkp, .r-m5arl1, .r-1bnu78o');
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (
                    line.compareDocumentPosition(avatar) & Node.DOCUMENT_POSITION_FOLLOWING &&
                    !line.contains(avatar)
                ) {
                    return true;
                }
            }
        }

        return false;
    }

    function updateReplyHiding(tweet, article, isDiscoverMore) {
        const prev = getPreviousCell(tweet);
        const isPrevHidden =
            !isDiscoverMore &&
            prev &&
            (prev.classList.contains('x-comment-blocker-hidden') ||
                prev.classList.contains('x-comment-blocker-hidden-reply'));
        const isHiddenReply = isPrevHidden && isReplyToParent(tweet, article);

        if (isHiddenReply) {
            tweet.classList.add('x-comment-blocker-hidden-reply');
        } else {
            tweet.classList.remove('x-comment-blocker-hidden-reply');
        }
        tweet.classList.remove('x-comment-blocker-hidden');
    }

    function filterTweets(specificTweets = null) {
        const tweets = specificTweets || document.querySelectorAll('[data-testid="cellInnerDiv"]');
        if (!tweets || tweets.length === 0) return;

        const pageContext = getPageContext();
        const isStatusPageBase = !!pageContext.pageStatusId;
        let isPastDiscoverMore = false;

        for (let i = 0; i < tweets.length; i++) {
            const tweet = tweets[i];
            let state = tweetStateMap.get(tweet);
            if (!state) {
                state = {};
                tweetStateMap.set(tweet, state);
            }

            const isStatusPage = pageContext.isPhotoVideoOverlay
                ? resolveStatusPage(tweet, pageContext)
                : isStatusPageBase;
            let logicalPageStatusId = pageContext.pageStatusId;
            if (pageContext.isPhotoVideoOverlay && tweet.closest('[role="dialog"]') === null) {
                logicalPageStatusId = state.pageStatusId ?? pageContext.pageStatusId;
            } else {
                state.pageStatusId = pageContext.pageStatusId;
            }
            state.isStatusPage = isStatusPage;

            let isDiscoverMore = false;
            if (isStatusPage) {
                if (!specificTweets) {
                    if (isDiscoverMoreHeader(tweet)) {
                        isPastDiscoverMore = true;
                        isDiscoverMore = false;
                    } else {
                        isDiscoverMore = isPastDiscoverMore;
                    }
                } else {
                    isDiscoverMore = isAfterDiscoverMore(tweet);
                }
            }
            state.isDiscoverMore = isDiscoverMore;

            const article = tweet.querySelector('article');
            if (!article) {
                state.quickHash = '';
                updateReplyHiding(tweet, null, isDiscoverMore);
                continue;
            }

            const userNode = tweet.querySelector('[data-testid="User-Name"]');
            const textNode = tweet.querySelector('[data-testid="tweetText"]');
            const fastText = textNode ? `${textNode.textContent}|${textNode.childElementCount}` : '';
            const rawUserName = userNode?.textContent ?? '';
            const grokElement = getGrokShareElement(tweet);
            const hasGrok = !!grokElement;

            const quickHash = `${fastText}|${rawUserName}|${blocklistVersion}|${isStatusPage}|${logicalPageStatusId || ''}|${hasGrok}|${isDiscoverMore}`;
            if (state.quickHash === quickHash) {
                if (state.isSpam) {
                    tweet.classList.remove('x-comment-blocker-hidden-reply');
                    tweet.classList.add('x-comment-blocker-hidden');
                    continue;
                }

                updateReplyHiding(tweet, article, isDiscoverMore);
                continue;
            }

            if (tweet.closest('[aria-hidden="true"]')) continue;

            let shouldCheck = blockRegexes.length > 0 || hasGrok;
            if (shouldCheck && !isStatusPage) shouldCheck = false;

            let isMainTweet = false;
            if (shouldCheck && isStatusPage && logicalPageStatusId) {
                isMainTweet = isMainTweetCell(tweet, logicalPageStatusId);
            }

            if (shouldCheck && (isMainTweet || isDiscoverMore)) shouldCheck = false;

            const rawTweetText = textNode ? getTweetTextForKeywords(textNode) : '';
            const isSpam = shouldCheck
                ? detectSpam(userNode, rawTweetText, grokElement)
                : false;

            state.quickHash = quickHash;
            state.isSpam = isSpam;

            if (isSpam) {
                tweet.classList.remove('x-comment-blocker-hidden-reply');
                tweet.classList.add('x-comment-blocker-hidden');
            } else {
                updateReplyHiding(tweet, article, isDiscoverMore);
            }
        }
    }

    let observerFlushScheduled = false;
    const pendingTweets = new Set();

    function getEnclosingTweetIfRelevant(target) {
        if (!target) return null;
        const elem = target.nodeType === Node.ELEMENT_NODE ? target : target.parentElement;
        if (!elem) return null;
        const enclosingCell = elem.closest('[data-testid="cellInnerDiv"]');
        if (!enclosingCell) return null;
        if (elem.closest('[data-testid="tweetText"], [data-testid="User-Name"]')) {
            return enclosingCell;
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
        injectStyles();
        const targetNode = document.body || document.documentElement;
        observer.observe(targetNode, {
            childList: true,
            subtree: true,
        });
        filterTweets();
    }

    window.addEventListener('pageshow', () => {
        injectStyles();
        filterTweets();
        syncCloudKeywords();
    });
    window.addEventListener('popstate', () => {
        setTimeout(() => {
            injectStyles();
            filterTweets();
        }, 50);
    });

    initObserver();
    syncCloudKeywords();
})();

