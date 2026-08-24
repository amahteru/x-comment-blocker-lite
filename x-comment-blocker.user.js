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
// @connect      fastly.jsdelivr.net
// ==/UserScript==

(function() {
    'use strict';

    const CLOUD_KEYWORDS_CDN = 'https://fastly.jsdelivr.net/gh/amahteru/x-comment-blocker@main/keywords.txt';
    const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
    const STORAGE_KEY_KEYWORDS = 'x_cb_cloud_keywords';
    const STORAGE_KEY_LAST_SYNC = 'x_cb_last_sync_time';

    const invisibleCharsRegex = /\p{Default_Ignorable_Code_Point}/gv;
    const hasInvisibleCharsRegex = /\p{Default_Ignorable_Code_Point}/v;
    const displayNamePunctRegex = /[\s_.\-]+/gv;
    const fastHandleRegex = /^[@\/]?(?<handle>[a-zA-Z0-9_]{1,15})$/v;
    const regexMetaCharRegex = /[.*+?^$\{\}\(\)\|\[\]\\]/v;
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
        const match = cleaned.match(/(?:^|\/|@)(?<handle>[a-zA-Z0-9_]{1,15})(?:\/|\?|$)/v);
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
        return typeof k === 'string' && k.length >= 3 && /^\/.+\/[a-zA-Z]*$/v.test(k);
    }

    const categoryHeaderRegex = /^#(?:\s*\[(?<bracketName>[^\]]+)\]|\s+(?<spaceName>\S+.*))$/v;

    function isCategoryHeader(cleanedLine) {
        return typeof cleanedLine === 'string' && (cleanedLine.startsWith('#') || categoryHeaderRegex.test(cleanedLine));
    }

    function parseKeywords(text) {
        if (!text) return [];
        const result = [];
        for (const line of text.split('\n')) {
            const k = cleanInvisibleChars(line).trim();
            if (!k || isCategoryHeader(k)) continue;
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
            for (const ch of kw) node = node[ch] ??= {};
        }

        function stringify(node) {
            const keys = Object.keys(node);
            if (!keys.length) return '';
            const branches = keys.map((k) => escapeChar(k) + stringify(node[k]));
            return branches.length > 1 ? `(?:${branches.join('|')})` : branches[0];
        }

        return new RegExp(stringify(root), 'iv');
    }

    function buildRegexes(keywords) {
        if (!Array.isArray(keywords) || keywords.length === 0) return [];
        const plainKeywords = [];
        const customRegexes = [];

        for (const kw of keywords) {
            if (typeof kw !== 'string') continue;
            const match = kw.startsWith('/')
                ? kw.match(/^\/(?<pattern>.+)\/(?<flags>[a-zA-Z]*)$/v)
                : null;
            if (match) {
                try {
                    const cleanFlags = match.groups.flags.replace(/[gy]/gv, '');
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
                    text += currentNode.alt;
                }
            }
            currentNode = walker.nextNode();
        }
        return text;
    }

    function getTweetStatusInfo(tweet, pageStatusId) {
        const timeElements = tweet.querySelectorAll('time');
        for (let i = 0; i < timeElements.length; i++) {
            const href = timeElements[i].closest('a')?.getAttribute('href');
            if (href) {
                const match = href.match(/\/status\/(\d+)/iv);
                if (match) {
                    const id = match[1];
                    return { id, isMainTweet: !!(pageStatusId && id === pageStatusId) };
                }
            }
        }
        return { id: null, isMainTweet: false };
    }

    function getPageContext() {
        const urlMatch = window.location.pathname.match(/\/status\/(\d+)/iv);
        return {
            pageStatusId: urlMatch ? urlMatch[1] : null,
            isPhotoVideoOverlay: /\/status\/\d+\/(?:photo|video)\//iv.test(window.location.pathname),
        };
    }

    function resolveStatusPage(tweet, pageContext) {
        if (pageContext.isPhotoVideoOverlay) {
            return tweet.closest('[role="dialog"]') !== null;
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
            if (stableHandle) {
                if (r.test(stableHandle)) return true;
                if (r.test(`@${stableHandle}`)) return true;
            }
        }
        return false;
    }

    function detectSpam(textNode, userNode, rawTweetText, grokElement = null) {
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
            return !!(btn && btn.querySelector('.r-m5arl1, .r-epq5cr, .r-1bnu78o'));
        }

        const avatar = tweet.querySelector('[data-testid="Tweet-User-Avatar"]');
        if (avatar) {
            const divs = tweet.querySelectorAll('div');
            for (let i = 0; i < divs.length; i++) {
                const d = divs[i];
                if ((d.compareDocumentPosition(avatar) & Node.DOCUMENT_POSITION_FOLLOWING) && !d.contains(avatar)) {
                    const cls = d.className || '';
                    if (cls.includes('r-15zivkp') || cls.includes('r-m5arl1') || cls.includes('r-1bnu78o')) {
                        return true;
                    }
                }
            }
        }

        const textNode = tweet.querySelector('[data-testid="tweetText"]');
        const allLinks = article.querySelectorAll('a[href^="/"]');
        const userNode = tweet.querySelector('[data-testid="User-Name"]');
        for (let i = 0; i < allLinks.length; i++) {
            const link = allLinks[i];
            if (!link.textContent?.trim().startsWith('@')) continue;
            if (userNode?.contains(link) || textNode?.contains(link)) continue;
            if (!textNode || (link.compareDocumentPosition(textNode) & Node.DOCUMENT_POSITION_FOLLOWING)) {
                return true;
            }
        }
        return false;
    }

    function updateReplyHiding(tweet, article) {
        const prev = getPreviousCell(tweet);
        const isPrevHidden =
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

            const article = tweet.querySelector('article');
            if (!article) {
                state.quickHash = '';
                updateReplyHiding(tweet, null);
                continue;
            }

            const userNode = tweet.querySelector('[data-testid="User-Name"]');
            const textNode = tweet.querySelector('[data-testid="tweetText"]');
            const fastText = textNode ? `${textNode.textContent}|${textNode.childElementCount}` : '';
            const rawUserName = userNode?.textContent ?? '';
            const grokElement = getGrokShareElement(tweet);
            const hasGrok = !!grokElement;

            const quickHash = `${fastText}|${rawUserName}|${blocklistVersion}|${isStatusPage}|${logicalPageStatusId || ''}|${hasGrok}`;
            if (state.quickHash === quickHash) {
                if (state.isSpam) {
                    tweet.classList.remove('x-comment-blocker-hidden-reply');
                    tweet.classList.add('x-comment-blocker-hidden');
                    continue;
                }

                updateReplyHiding(tweet, article);
                continue;
            }

            if (tweet.closest('[aria-hidden="true"]')) continue;

            let isMainTweet = false;
            if (isStatusPage && logicalPageStatusId) {
                const statusInfo = getTweetStatusInfo(tweet, logicalPageStatusId);
                isMainTweet = statusInfo.isMainTweet;
            }

            if (isMainTweet && tweet.querySelector('article')) {
                continue;
            }

            const rawTweetText = textNode ? getTweetTextForKeywords(textNode) : '';
            const isSpam = detectSpam(textNode, userNode, rawTweetText, grokElement);

            state.quickHash = quickHash;
            state.isSpam = isSpam;

            if (isSpam) {
                tweet.classList.remove('x-comment-blocker-hidden-reply');
                tweet.classList.add('x-comment-blocker-hidden');
            } else {
                updateReplyHiding(tweet, article);
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

