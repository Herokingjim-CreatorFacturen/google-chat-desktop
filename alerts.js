'use strict';

/**
 * Decide which sound an incoming notification should play.
 *
 * Keywords are checked before VIPs, and against the message text as well as the
 * sender. A VIP rule answers "who is this from"; a keyword answers "is this
 * about me" -- your own name, a project, an incident -- which is the stronger
 * reason to interrupt. A keyword hit also bypasses the sound throttle, so it
 * still fires in a room that is already busy.
 *
 * @param {{title?: string, body?: string}} notification
 * @param {{keywordSounds?: Object, vipSounds?: Object}} config
 * @returns {{sound: string|null, urgent: boolean, matched: 'keyword'|'vip'|'none', term: string|null}}
 */
function pickAlertSound(notification = {}, config = {}) {
  const title = String(notification.title == null ? '' : notification.title);
  const body = String(notification.body == null ? '' : notification.body);
  const { keywordSounds = {}, vipSounds = {} } = config;

  const haystack = `${title}\n${body}`.toLowerCase();

  for (const [word, sound] of Object.entries(keywordSounds)) {
    if (word && haystack.includes(word.toLowerCase())) {
      return { sound, urgent: true, matched: 'keyword', term: word };
    }
  }

  const senderText = title.toLowerCase();
  for (const [name, sound] of Object.entries(vipSounds)) {
    if (name && senderText.includes(name.toLowerCase())) {
      return { sound, urgent: false, matched: 'vip', term: name };
    }
  }

  return { sound: null, urgent: false, matched: 'none', term: null };
}

module.exports = { pickAlertSound };
