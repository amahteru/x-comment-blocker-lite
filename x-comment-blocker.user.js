// ==UserScript==
// @name         X(Twitter) Comment Blocker Lite
// @namespace    http://tampermonkey.net/
// @version      1.4.1
// @description  一键净化 X (Twitter) 评论区，自动屏蔽垃圾信息与引流机器人。
// @author       amahteru
// @match        *://x.com/*
// @match        *://twitter.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=x.com
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      fastly.jsdelivr.net
// ==/UserScript==

(function() {
    'use strict';

    const CLOUD_KEYWORDS_CDN = 'https://fastly.jsdelivr.net/gh/amahteru/x-comment-blocker@main/keywords.txt';
    const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;

    const invisibleCharsRegex = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFEFF\uFFA0]/g;
    let blockRegexes = [];

    function parseKeywords(text) {
        if (!text) return [];
        return text.split('\n')
            .map(k => k.replaceAll(invisibleCharsRegex, '').trim())
            .filter(k => k);
    }

    function buildRegexes(keywords) {
        if (!keywords || keywords.length === 0) return [];
        const plainKeywords = [];
        const customRegexes = [];

        for (const kw of keywords) {
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
                plainKeywords.push(kw.toLowerCase());
            }
        }

        const regexes = [];
        if (plainKeywords.length > 0) {
            const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const escaped = plainKeywords.map(escapeRegExp).sort((a, b) => b.length - a.length);
            const CHUNK_SIZE = 400;
            for (let i = 0; i < escaped.length; i += CHUNK_SIZE) {
                const chunk = escaped.slice(i, i + CHUNK_SIZE);
                regexes.push(new RegExp(chunk.join('|'), 'i'));
            }
        }
        if (customRegexes.length > 0) {
            regexes.push(...customRegexes);
        }
        return regexes;
    }

    const cachedKeywords = GM_getValue('cloudKeywords', []);
    blockRegexes = buildRegexes(cachedKeywords);

    function syncCloudKeywords() {
        const lastSyncTime = GM_getValue('lastSyncTime', 0);
        if (Date.now() - lastSyncTime < SYNC_INTERVAL_MS && cachedKeywords.length > 0) {
            return;
        }

        GM_xmlhttpRequest({
            method: 'GET',
            url: `${CLOUD_KEYWORDS_CDN}?t=${Date.now()}`,
            onload: function(response) {
                if (response.status === 200) {
                    const keywords = parseKeywords(response.responseText);
                    if (keywords.length > 0) {
                        GM_setValue('cloudKeywords', keywords);
                        GM_setValue('lastSyncTime', Date.now());
                        blockRegexes = buildRegexes(keywords);
                        console.log(`[X-Blocker] Cloud keywords synced: ${keywords.length} items.`);
                        filterTweets();
                    }
                }
            },
            onerror: function(error) {
                console.error('[X-Blocker] Failed to sync cloud keywords:', error);
            }
        });
    }

    function matchesBlocklist(text) {
        if (blockRegexes.length === 0) return false;
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
        return text.toLowerCase();
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
            if (tweet.closest('[role="dialog"]') !== null) return true;
            return false;
        }
        return !!pageContext.pageStatusId;
    }
    
    function extractCleanScreenName(input) {
      if (!input) return '';
      const cleaned = input.replaceAll(invisibleCharsRegex, '').trim();
      const match = cleaned.match(/(?:^|\/|@)(?<handle>[a-zA-Z0-9_]{1,15})(?:\/|\?|$)/v);
      if (match) return match.groups.handle.toLowerCase();
      return cleaned
        .replace(/^[@\/]+/v, '')
        .split(/[\/?]/v)
        .at(0)
        .toLowerCase();
    }

    function hasGrokCard(tweet) {
        if (!tweet) return false;
        return !!tweet.querySelector('a[href*="/i/grok/share"], meta[content*="/i/grok/share"]');
    }

    function detectSpam(tweet, textNode, userNode) {
        if (hasGrokCard(tweet)) return true;

        const rawTweetText = textNode ? getTweetTextForKeywords(textNode) : '';
        const tweetBody = rawTweetText.replaceAll(invisibleCharsRegex, '');
        
        let stableHandle = '';
        const handleLink = userNode?.querySelector('a[href^="/"]');
        if (handleLink) {
            const rawHref = handleLink.getAttribute('href') || '';
            stableHandle = extractCleanScreenName(rawHref);
        }

        const rawUserName = userNode ? getTweetTextForKeywords(userNode) : '';
        const userName = rawUserName.replaceAll(/[\s_.\-]+/gv, '').replaceAll(invisibleCharsRegex, '');

        if (matchesBlocklist(tweetBody) || matchesBlocklist(userName) || matchesBlocklist(stableHandle)) {
            return true;
        }
        return false;
    }

    const tweetStateMap = new WeakMap();

    function filterTweets(specificTweets = null) {
        const tweets = specificTweets || document.querySelectorAll('[data-testid="cellInnerDiv"]');
        if (tweets.length === 0) return;

        const pageContext = getPageContext();

        for (const tweet of tweets) {
            const userNode = tweet.querySelector('[data-testid="User-Name"]');
            const textNode = tweet.querySelector('[data-testid="tweetText"]');
            const isStatusPage = resolveStatusPage(tweet, pageContext);

            if (!isStatusPage) continue;
            
            const timeMatch = Array.from(tweet.querySelectorAll('time'))
              .map((timeEl) =>
                timeEl
                  .closest('a')
                  ?.getAttribute('href')
                  ?.match(/\/status\/(\d+)/iv),
              )
              .find((m) => m);
            if (timeMatch && timeMatch[1] === pageContext.pageStatusId && tweet.querySelector('article')) {
               continue;
            }

            if (tweet.closest('[aria-hidden="true"]')) continue;

            const rawTweetText = textNode ? getTweetTextForKeywords(textNode) : '';
            const rawUserName = userNode ? getTweetTextForKeywords(userNode) : '';
            
            const prev = tweet.previousElementSibling;
            const prevHidden = prev && (prev.dataset.xCbHidden === 'true' || prev.dataset.xCbHiddenReply === 'true');

            const quickHash = `${rawTweetText}|${rawUserName}|${prevHidden}`;

            let state = tweetStateMap.get(tweet);
            if (!state) {
                state = {};
                tweetStateMap.set(tweet, state);
            }

            if (state.quickHash === quickHash) {
                if (state.isSpam) {
                    tweet.style.display = 'none';
                    tweet.dataset.xCbHidden = 'true';
                } else if (state.isHiddenReply) {
                    tweet.style.display = 'none';
                    tweet.dataset.xCbHiddenReply = 'true';
                } else {
                    tweet.style.display = '';
                    delete tweet.dataset.xCbHidden;
                    delete tweet.dataset.xCbHiddenReply;
                }
                continue;
            }

            state.quickHash = quickHash;
            const isSpam = detectSpam(tweet, textNode, userNode);
            state.isSpam = isSpam;

            let isHiddenReply = false;
            if (!isSpam && prevHidden) {
                const hasThreadLine = !!tweet.querySelector('div[style*="width: 2px"]') || !!tweet.querySelector('[class*="r-1d2f490"]');
                const hasReplyingTo = !!tweet.querySelector('div[dir="ltr"] a[href^="/"]');
                if (hasThreadLine || hasReplyingTo) {
                    isHiddenReply = true;
                }
            }
            state.isHiddenReply = isHiddenReply;

            if (isSpam) {
                tweet.style.display = 'none';
                tweet.dataset.xCbHidden = 'true';
                delete tweet.dataset.xCbHiddenReply;
            } else if (isHiddenReply) {
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

    let observerFlushScheduled = false;
    const pendingTweets = new Set();

    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    if (node.getAttribute('data-testid') === 'cellInnerDiv') {
                        pendingTweets.add(node);
                    } else if (node.querySelector) {
                        const innerTweets = node.querySelectorAll('[data-testid="cellInnerDiv"]');
                        innerTweets.forEach((t) => {
                            pendingTweets.add(t);
                        });
                    }
                }
            }

            const el = mutation.target;
            if (!el.closest('[data-testid="tweetText"], [data-testid="User-Name"]')) {
                continue;
            }
            const closestTweet = el.closest('[data-testid="cellInnerDiv"]');
            if (closestTweet) {
                pendingTweets.add(closestTweet);
            }
        }

        if (pendingTweets.size > 0 && !observerFlushScheduled) {
            observerFlushScheduled = true;
            queueMicrotask(() => {
                observerFlushScheduled = false;
                if (pendingTweets.size > 0) {
                    filterTweets(Array.from(pendingTweets));
                    pendingTweets.clear();
                }
            });
        }
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true,
    });
    
    syncCloudKeywords();
    setTimeout(() => {
        filterTweets();
    }, 1000);

})();
