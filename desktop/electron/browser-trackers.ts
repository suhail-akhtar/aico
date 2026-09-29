/**
 * Tracker blocking for the built-in browser — the pure half: the list and the
 * matching rules and who is behind each tracker. `browser.ts` applies it to
 * the browser partition's requests; `browser-privacy.ts` tallies what was
 * blocked per company for the shields panel and insights.
 *
 * The list is a compact, curated set of well-known third-party analytics,
 * advertising, fingerprinting and session-recording hosts (the core of what
 * Disconnect / EasyPrivacy block by name). A request is blocked only when:
 *
 *   - it is not a main-frame navigation (a page you open is never blocked), and
 *   - its host is, or is under, a listed domain, and
 *   - it is third-party: its registrable domain differs from the page's
 *     (google-analytics.com loading on google-analytics.com is left alone).
 *
 * Human-check providers (reCAPTCHA, hCaptcha, Turnstile) and CDNs are
 * deliberately NOT on the list: blocking them would break sign-ins.
 *
 * @module desktop/electron/browser-trackers
 */

export const TRACKER_DOMAINS: readonly string[] = [
  // Google advertising and analytics
  'google-analytics.com', 'googletagmanager.com', 'googletagservices.com', 'googleadservices.com', 'googlesyndication.com',
  'doubleclick.net', 'adservice.google.com', 'pagead2.googlesyndication.com', 'app-measurement.com',
  'firebaselogging-pa.googleapis.com', 'analytics.google.com', 'stats.g.doubleclick.net', 'admob.com', 'invitemedia.com',
  // Meta / social
  'connect.facebook.net', 'pixel.facebook.com', 'an.facebook.com', 'graph.instagram.com', 'ads-twitter.com',
  'analytics.twitter.com', 'static.ads-twitter.com', 'ads.linkedin.com', 'px.ads.linkedin.com', 'snap.licdn.com',
  'analytics.tiktok.com', 'ads.tiktok.com', 'business-api.tiktok.com', 'ct.pinterest.com', 'analytics.pinterest.com',
  'sc-static.net', 'tr.snapchat.com', 'ads.reddit.com', 'events.redditmedia.com', 'alb.reddit.com', 'pixel.quora.com',
  'ads.yahoo.com', 'analytics.yahoo.com', 'sp.analytics.yahoo.com', 'bat.bing.com', 'clarity.ms', 'c.clarity.ms',
  'ads.microsoft.com', 'c.bing.com', 'adnxs.com', 'adnxs-simple.com', 'atdmt.com',
  // Amazon ads
  'amazon-adsystem.com', 'assoc-amazon.com', 'aax.amazon-adsystem.com',
  // Product analytics / session replay
  'hotjar.com', 'hotjar.io', 'static.hotjar.com', 'mouseflow.com', 'fullstory.com', 'logrocket.com', 'lr-ingest.io',
  'lr-in.com', 'luckyorange.com', 'luckyorange.net', 'crazyegg.com', 'inspectlet.com', 'smartlook.com', 'smartlook.cloud',
  'quantummetric.com', 'contentsquare.net', 'contentsquare.com', 'clicktale.net', 'decibelinsight.net', 'glassboxdigital.io',
  'heap.io', 'heapanalytics.com', 'mixpanel.com', 'mxpnl.com', 'mxpnl.net', 'segment.com', 'segment.io', 'cdn.segment.com',
  'api.segment.io', 'amplitude.com', 'api.amplitude.com', 'api2.amplitude.com', 'cdn.amplitude.com', 'kissmetrics.com',
  'kissmetrics.io', 'pendo.io', 'woopra.com', 'chartbeat.com', 'chartbeat.net', 'parsely.com', 'parse.ly', 'statcounter.com',
  'clicky.com', 'getclicky.com', 'static.getclicky.com', 'mc.yandex.ru', 'mc.yandex.com', 'top-fwz1.mail.ru', 'counter.yadro.ru',
  'hm.baidu.com', 'cnzz.com', 'umeng.com', 'newrelic.com', 'nr-data.net', 'js-agent.newrelic.com', 'bam.nr-data.net',
  'optimizely.com', 'cdn.optimizely.com', 'logx.optimizely.com', 'vwo.com', 'visualwebsiteoptimizer.com', 'abtasty.com',
  'kameleoon.com', 'kameleoon.eu', 'omtrdc.net', '2o7.net', 'demdex.net', 'everesttech.net', 'adobedtm.com',
  'sc.omtrdc.net', 'tt.omtrdc.net', 'mktoresp.com', 'munchkin.marketo.net', 'hs-analytics.net', 'hs-banner.com',
  'hsadspixel.net', 'hsleadflows.net', 'track.hubspot.com', 'pi.pardot.com',
  'bizible.com', 'bizibly.com', 'eloqua.com', 'en25.com', 'reveal.clearbit.com',
  'leadfeeder.com', 'lfeeder.com', 'albacross.com', 'zoominfo.com', 'ws.zoominfo.com', 'sixsense.com', 'j.6sc.co', 'b.6sc.co',
  'demandbase.com', 'tag.demandbase.com', 'bombora.com', 'ml314.com', 'rlcdn.com', 'rlets.com', 'liveramp.com',
  'krxd.net', 'bluekai.com', 'exelator.com', 'eyeota.net', 'lotame.com', 'crwdcntrl.net', 'tapad.com', 'agkn.com',
  'adsrvr.org', 'thetradedesk.com', 'mathtag.com', 'mediamath.com', 'bidswitch.net', 'casalemedia.com', 'indexww.com',
  'rubiconproject.com', 'pubmatic.com', 'openx.net', 'openx.com', 'contextweb.com', 'sovrn.com', 'lijit.com', 'yieldmo.com',
  'sharethrough.com', 'triplelift.com', '3lift.com', 'teads.tv', 'smartadserver.com', 'adform.net', 'adformdsp.net',
  'criteo.com', 'criteo.net', 'emxdgt.com', 'gumgum.com', 'media.net', 'spotxchange.com', 'spotx.tv', 'springserve.com',
  'districtm.io', 'adcolony.com', 'applovin.com', 'unityads.unity3d.com', 'inmobi.com', 'mopub.com', 'chartboost.com',
  'vungle.com', 'ironsrc.com', 'adsafeprotected.com', 'moatads.com', 'moatpixel.com', 'doubleverify.com', 'iasds01.com',
  'serving-sys.com', 'flashtalking.com', 'sizmek.com', 'innovid.com', 'tremorhub.com', 'yieldlab.net', 'adition.com',
  'adhigh.net', 'stickyadstv.com', 'zemanta.com', 'revcontent.com', 'mgid.com', 'taboola.com', 'taboolasyndication.com',
  'outbrain.com', 'outbrainimg.com', 'zergnet.com', 'content.ad', 'nativo.com', 'plista.com', 'ligatus.com',
  'scorecardresearch.com', 'comscore.com', 'imrworldwide.com', 'nielsen.com', 'quantserve.com', 'quantcount.com',
  'quantcast.com', 'alexametrics.com', 'effectivemeasure.net', 'gemius.pl', 'hit.gemius.pl', 'xiti.com', 'atinternet.com',
  'webtrends.com', 'webtrendslive.com', 'coremetrics.com', 'cmcore.com', 'tealiumiq.com', 'tiqcdn.com', 'ensighten.com',
  'nexus.ensighten.com', 'bounceexchange.com', 'bouncex.net', 'wunderkind.co', 
  'addthis.com', 'addthisedge.com', 'sharethis.com', 'po.st', 'shareaholic.com', 'disqusads.com', 'zqtk.net',
  'branch.io', 'appsflyer.com', 'adjust.com', 'kochava.com', 'singular.net', 'tenjin.io',
  'impactradius-event.com', 'ojrq.net', 'sjv.io',
  'awin1.com', 'zenaps.com', 'dwin1.com', 'cj.com', 'emjcd.com', 'anrdoezrs.net', 'dpbolvw.net', 'jdoqocy.com',
  'kqzyfj.com', 'tkqlhce.com', 'qksrv.net', 'linksynergy.com', 'rakuten-marketing.com', 'shareasale.com',
  'shareasale-analytics.com', 'pepperjam.com', 'pjtra.com', 'pntra.com', 'avantlink.com', 'skimlinks.com', 'skimresources.com',
  'viglink.com', 'redirectingat.com', 'go.redirectingat.com', 'partnerize.com', 'prf.hn', 'tradedoubler.com', 'webgains.com',
  'everflow.io', 'tapfiliate.com', 'refersion.com', 'friendbuy.com', 'extole.com', 'curalate.com',
  'adriver.ru', 'adfox.ru', 'begun.ru', 'tns-counter.ru',
  'adskeeper.co.uk', 'adsterra.com', 'propellerads.com', 'popads.net', 'popcash.net', 'exoclick.com', 'juicyads.com',
  'trafficjunky.net', 'trafficstars.com', 'hilltopads.net', 'clickadu.com', 'adcash.com', 'admaven.com', 'onclickads.net',
  'zedo.com', 'yieldlove.com', 'yieldlove-ad-serving.net', 'adrecover.com', 'admixer.net', 'adtelligent.com', 'undertone.com',
  'conversantmedia.com', 'dotomi.com', 'fastclick.net', 'valueclick.com', 'advertising.com', 'adtech.de', 'adtechus.com',
  'bidr.io', 'beeswax.com', 'simpli.fi', 'sitescout.com', 'steelhousemedia.com', 'dstillery.com',
  'media6degrees.com', 'owneriq.net', 'rfihub.com', 'rfihub.net', 'turn.com', 'mookie1.com', 'adgrx.com', 'rtbhouse.com',
  'creativecdn.com', 'rtb-house.com', 'advertising.yahoo.com', 'gemini.yahoo.com', 'onebyaol.com',
  'intentiq.com', 'id5-sync.com', 'uidapi.com', 'liadm.com', 'connectid.analytics.yahoo.com',
  'permutive.com', 'permutive.app', 'cdn.permutive.com', 'cxense.com', 'npttech.com',
  'blueconic.net', 'evergage.com', 'monetate.net', 'dynamicyield.com', 'rlcdn.net',
  'richrelevance.com', 'certona.net', 'brightedge.com', 'cquotient.com', 'dc-storm.com', 'channeladvisor.com',
  'foresee.com', 'foreseeresults.com', 'kampyle.com', 'qualaroo.com', 'iperceptions.com',
  'opinionlab.com', 'usabilla.com', 'getsitecontrol.com', 'sumo.com', 'sumome.com', 
  'justuno.com', 'optinmonster.com', 'omappapi.com', 'wisepops.com', 'exponea.com', 
  'appboy.com', 'a.klaviyo.com',
  'track.customer.io', 
  'trackjs.com', 'errorception.com',
  'speedcurve.com', 'lognormal.net', 'go-mpulse.net', 'mpulse.net', 'akstat.io', 'cloudflareinsights.com',
  'static.cloudflareinsights.com', 'matomo.cloud', 'piwik.pro', 'piwikpro.com',
  'mouseflow.net', 'userzoom.com', 'hotjar.net', 'survicate.com', 
  'callrail.com', 'calltrk.com', 'callrail.net',
  'marchex.io', 'invoca.net', 'invocacdn.com', 'dialogtech.com', 'convertro.com', 'visualiq.com', 'c3tag.com',
  'adroll.com', 'd.adroll.com', 'perfectaudience.com', 'retargeter.com', 'chango.com', 'fetchback.com', 'criteo.fr',
  'omnitagjs.com', 'adotmob.com', 'weborama.fr', 'weborama.com', 'mediarithmics.com', 'ad6media.fr', 'sddan.com',
  'teads.com', 'ayads.co', 'seedtag.com', 'outbrain.org', 'ads.pubmatic.com', 'ib.adnxs.com', 'secure.adnxs.com',
  'cdn.taboola.com', 'trc.taboola.com', 'widgets.outbrain.com', 'log.outbrain.com', 'b.scorecardresearch.com',
  'sb.scorecardresearch.com', 'pixel.adsafeprotected.com', 'z.moatads.com', 'cdn.doubleverify.com', 'tps.doubleverify.com',
  // Fingerprinting and cross-site identity (device IDs that survive cookie clearing)
  'fpjs.io', 'fpcdn.io', 'openfpcdn.io', 'fpnpmcdn.net', 'api.fpjs.io', 'fingerprintjs.com', 'pippio.com', 'adsymptotic.com',
  'ad.gt', 'audigent.com', 'sharedid.org', 'zeotap.com', 'lotame.io', 'tru.am', 'adsco.re', 'id5.io',
  // More analytics, ads and tag managers seen on large news and shopping sites
  'i.posthog.com', 'us.i.posthog.com', 'eu.i.posthog.com', 'dataplane.rudderstack.com', 'sessioncam.com', 'stats.wp.com',
  'pixel.wp.com', 'ads.pinterest.com', 'px.srvcs.tumblr.com', 'yieldmanager.com', 'amplify.outbrain.com',
  'googleoptimize.com', 'tagcommander.com', 'commander1.com', 'cxense.net',
  'omnitagjs.net', 'adlightning.com', 'confiant-integrations.net',
  'adthrive.com', 'mediavine.com', 'ezoic.net', 'ezojs.com', 'freestar.com', 'pbstck.com', 'kargo.com', 'undertone.net',
  'connatix.com', 'primis.tech', 'vidazoo.com', 'aniview.com', 'minutemedia-prebid.com', 'loopme.me',
];

export type TrackerCategory = 'ads' | 'analytics' | 'social' | 'fingerprinting' | 'session-replay';

/**
 * Who is behind a tracker host, for the shields panel and insights ("Google —
 * 14 requests"). Keyed by listed domain; a domain not named here is reported
 * under its own registrable domain. Categories follow Disconnect's broad split.
 */
const COMPANIES: Array<[string, TrackerCategory, string[]]> = [
  ['Google', 'ads', ['google-analytics.com', 'googletagmanager.com', 'googletagservices.com', 'googleadservices.com', 'googlesyndication.com', 'doubleclick.net', 'adservice.google.com', 'app-measurement.com', 'firebaselogging-pa.googleapis.com', 'analytics.google.com', 'admob.com', 'invitemedia.com', 'googleoptimize.com']],
  ['Meta', 'social', ['connect.facebook.net', 'pixel.facebook.com', 'an.facebook.com', 'graph.instagram.com']],
  ['X (Twitter)', 'social', ['ads-twitter.com', 'analytics.twitter.com', 'static.ads-twitter.com']],
  ['Microsoft', 'ads', ['ads.linkedin.com', 'px.ads.linkedin.com', 'snap.licdn.com', 'bat.bing.com', 'clarity.ms', 'c.clarity.ms', 'ads.microsoft.com', 'c.bing.com', 'atdmt.com', 'adnxs.com', 'adnxs-simple.com']],
  ['TikTok (ByteDance)', 'social', ['analytics.tiktok.com', 'ads.tiktok.com', 'business-api.tiktok.com']],
  ['Pinterest', 'social', ['ct.pinterest.com', 'analytics.pinterest.com', 'ads.pinterest.com']],
  ['Snap', 'social', ['sc-static.net', 'tr.snapchat.com']],
  ['Reddit', 'social', ['ads.reddit.com', 'events.redditmedia.com', 'alb.reddit.com']],
  ['Yahoo', 'ads', ['ads.yahoo.com', 'analytics.yahoo.com', 'sp.analytics.yahoo.com', 'advertising.yahoo.com', 'gemini.yahoo.com', 'onebyaol.com', 'connectid.analytics.yahoo.com', 'yieldmanager.com', 'px.srvcs.tumblr.com']],
  ['Amazon', 'ads', ['amazon-adsystem.com', 'assoc-amazon.com']],
  ['Contentsquare', 'session-replay', ['hotjar.com', 'hotjar.io', 'hotjar.net', 'contentsquare.net', 'contentsquare.com', 'clicktale.net']],
  ['FullStory', 'session-replay', ['fullstory.com']], ['LogRocket', 'session-replay', ['logrocket.com', 'lr-ingest.io', 'lr-in.com']],
  ['Mouseflow', 'session-replay', ['mouseflow.com', 'mouseflow.net']], ['Lucky Orange', 'session-replay', ['luckyorange.com', 'luckyorange.net']],
  ['Crazy Egg', 'session-replay', ['crazyegg.com']], ['Smartlook', 'session-replay', ['smartlook.com', 'smartlook.cloud']],
  ['Quantum Metric', 'session-replay', ['quantummetric.com']], ['SessionCam', 'session-replay', ['sessioncam.com']],
  ['Adobe', 'analytics', ['omtrdc.net', '2o7.net', 'demdex.net', 'everesttech.net', 'adobedtm.com', 'mktoresp.com', 'munchkin.marketo.net', 'bizible.com', 'bizibly.com']],
  ['HubSpot', 'analytics', ['hs-analytics.net', 'hs-banner.com', 'hsadspixel.net', 'hsleadflows.net', 'track.hubspot.com']],
  ['Salesforce', 'analytics', ['pi.pardot.com', 'evergage.com', 'krxd.net', 'cquotient.com']],
  ['Oracle', 'ads', ['bluekai.com', 'eloqua.com', 'en25.com', 'moatads.com', 'moatpixel.com', 'addthis.com', 'addthisedge.com']],
  ['Criteo', 'ads', ['criteo.com', 'criteo.net', 'criteo.fr']], ['Taboola', 'ads', ['taboola.com', 'taboolasyndication.com']],
  ['Outbrain', 'ads', ['outbrain.com', 'outbrainimg.com', 'outbrain.org', 'zemanta.com']],
  ['Comscore', 'analytics', ['scorecardresearch.com', 'comscore.com']], ['Nielsen', 'analytics', ['imrworldwide.com', 'nielsen.com', 'exelator.com']],
  ['Quantcast', 'ads', ['quantserve.com', 'quantcount.com', 'quantcast.com']], ['The Trade Desk', 'ads', ['adsrvr.org', 'thetradedesk.com']],
  ['LiveRamp', 'fingerprinting', ['rlcdn.com', 'rlcdn.net', 'rlets.com', 'liveramp.com', 'pippio.com']],
  ['FingerprintJS', 'fingerprinting', ['fpjs.io', 'fpcdn.io', 'openfpcdn.io', 'fpnpmcdn.net', 'fingerprintjs.com']],
  ['ID5', 'fingerprinting', ['id5-sync.com', 'id5.io']], ['Unified ID 2.0', 'fingerprinting', ['uidapi.com']],
  ['LiveIntent', 'fingerprinting', ['liadm.com']], ['Intent IQ', 'fingerprinting', ['intentiq.com']], ['Tapad', 'fingerprinting', ['tapad.com']],
  ['Neustar', 'fingerprinting', ['agkn.com']], ['Lotame', 'fingerprinting', ['crwdcntrl.net', 'lotame.com', 'lotame.io']],
  ['Zeotap', 'fingerprinting', ['zeotap.com']], ['SharedID', 'fingerprinting', ['sharedid.org']], ['Audigent', 'fingerprinting', ['ad.gt', 'audigent.com']],
  ['Mixpanel', 'analytics', ['mixpanel.com', 'mxpnl.com', 'mxpnl.net']], ['Twilio Segment', 'analytics', ['segment.com', 'segment.io']],
  ['Amplitude', 'analytics', ['amplitude.com']], ['Heap', 'analytics', ['heap.io', 'heapanalytics.com']], ['New Relic', 'analytics', ['newrelic.com', 'nr-data.net']],
  ['Optimizely', 'analytics', ['optimizely.com']], ['Chartbeat', 'analytics', ['chartbeat.com', 'chartbeat.net']], ['Parse.ly', 'analytics', ['parsely.com', 'parse.ly']],
  ['Yandex', 'analytics', ['mc.yandex.ru', 'mc.yandex.com']], ['Baidu', 'analytics', ['hm.baidu.com']], ['Akamai', 'analytics', ['go-mpulse.net', 'mpulse.net', 'akstat.io']],
  ['Cloudflare', 'analytics', ['cloudflareinsights.com']], ['Tealium', 'analytics', ['tealiumiq.com', 'tiqcdn.com']], ['Permutive', 'ads', ['permutive.com', 'permutive.app']],
  ['Index Exchange', 'ads', ['casalemedia.com', 'indexww.com']], ['Magnite', 'ads', ['rubiconproject.com', 'spotxchange.com', 'spotx.tv', 'tremorhub.com']],
  ['PubMatic', 'ads', ['pubmatic.com']], ['OpenX', 'ads', ['openx.net', 'openx.com']], ['DoubleVerify', 'ads', ['doubleverify.com']],
  ['Integral Ad Science', 'ads', ['adsafeprotected.com', 'iasds01.com']], ['AppsFlyer', 'analytics', ['appsflyer.com']], ['Adjust', 'analytics', ['adjust.com']],
  ['Branch', 'analytics', ['branch.io']], ['Piano', 'analytics', ['cxense.com', 'cxense.net', 'npttech.com']],
  ['PostHog', 'analytics', ['i.posthog.com']], ['Automattic', 'analytics', ['stats.wp.com', 'pixel.wp.com']], ['Mediavine', 'ads', ['mediavine.com']],
  ['Raptive', 'ads', ['adthrive.com']], ['Ezoic', 'ads', ['ezoic.net', 'ezojs.com']], ['Teads', 'ads', ['teads.tv', 'teads.com']], ['TripleLift', 'ads', ['triplelift.com', '3lift.com']],
  ['Sovrn', 'ads', ['sovrn.com', 'lijit.com']], ['Media.net', 'ads', ['media.net']], ['AdRoll', 'ads', ['adroll.com']], ['RTB House', 'ads', ['rtbhouse.com', 'creativecdn.com', 'rtb-house.com']],
];

const COMPANY_OF = new Map<string, { company: string; category: TrackerCategory }>();
for (const [company, category, domains] of COMPANIES) for (const d of domains) COMPANY_OF.set(d, { company, category });

const SESSION_REPLAY = /hotjar|mouseflow|fullstory|logrocket|smartlook|inspectlet|clicktale|sessioncam|glassbox|decibel|quantummetric|contentsquare|luckyorange|crazyegg/;
const ANALYTICS = /analytic|metric|stat|segment|amplitude|mixpanel|heap|pendo|woopra|clicky|matomo|piwik|optimizely|vwo|abtasty|kameleoon|newrelic|nr-data|speedcurve|trackjs|chartbeat|parse/;

/** The company behind a tracker host (or its registrable domain when unnamed) and what kind of tracking it does. */
export function trackerOwner(trackerHost: string): { company: string; category: TrackerCategory } {
  const d = trackerHost.toLowerCase();
  const parts = d.split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    const hit = COMPANY_OF.get(parts.slice(i).join('.'));
    if (hit) return hit;
  }
  const category: TrackerCategory = SESSION_REPLAY.test(d) ? 'session-replay' : ANALYTICS.test(d) ? 'analytics' : 'ads';
  return { company: registrableDomain(d), category };
}

/**
 * Suffixes where a registrable domain needs three labels (example.co.uk).
 * Not the whole Public Suffix List — the common ones, which is enough to keep
 * a site's own subdomains first-party.
 */
const MULTI_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'ltd.uk', 'plc.uk', 'me.uk', 'net.uk', 'sch.uk', 'nhs.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'co.nz', 'org.nz', 'govt.nz', 'ac.nz',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp', 'co.kr', 'or.kr', 'ac.kr', 'go.kr',
  'com.br', 'net.br', 'org.br', 'gov.br', 'com.ar', 'com.mx', 'gob.mx', 'com.co', 'com.pe', 'com.ve', 'com.uy', 'com.ec',
  'co.in', 'net.in', 'org.in', 'gov.in', 'ac.in', 'firm.in', 'gen.in', 'ind.in', 'res.in',
  'com.pk', 'net.pk', 'org.pk', 'edu.pk', 'gov.pk', 'com.bd', 'com.lk', 'com.np',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'com.hk', 'org.hk', 'com.tw', 'org.tw', 'com.sg', 'edu.sg', 'gov.sg',
  'com.my', 'com.ph', 'com.vn', 'co.th', 'in.th', 'co.id', 'or.id', 'ac.id', 'go.id',
  'com.tr', 'gov.tr', 'org.tr', 'com.sa', 'com.eg', 'co.il', 'org.il', 'ac.il', 'co.za', 'org.za', 'gov.za', 'ac.za',
  'com.ng', 'co.ke', 'or.ke', 'co.tz', 'co.ug', 'com.gh', 'com.ua', 'org.ua', 'com.ru', 'net.ru', 'org.ru', 'com.pl', 'net.pl',
  'co.at', 'or.at', 'com.es', 'com.pt', 'com.gr', 'co.it', 'com.qa', 'com.kw', 'com.om', 'com.bh', 'ae.org',
  'github.io', 'gitlab.io', 'herokuapp.com', 'vercel.app', 'netlify.app', 'pages.dev', 'workers.dev', 'web.app',
  'firebaseapp.com', 'appspot.com', 'azurewebsites.net', 'cloudfront.net', 'blogspot.com', 'wordpress.com',
]);

const TRACKERS = new Set(TRACKER_DOMAINS.map(d => d.toLowerCase()));

/** The number of distinct, real domains on the list. */
export function trackerCount(): number { return TRACKERS.size; }

const isIp = (host: string): boolean => /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');

/** The part of a host a site owns: news.bbc.co.uk → bbc.co.uk, a.b.example.com → example.com. */
export function registrableDomain(host: string): string {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h || isIp(h)) return h;
  const parts = h.split('.');
  if (parts.length <= 2) return h;
  const last2 = parts.slice(-2).join('.');
  if (MULTI_PART_SUFFIXES.has(last2)) return parts.slice(-3).join('.');
  return last2;
}

/** The listed tracker domain a host falls under, or null. */
export function trackerDomainFor(host: string): string | null {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (!h || isIp(h)) return null;
  const parts = h.split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    const cand = parts.slice(i).join('.');
    if (TRACKERS.has(cand)) return cand;
  }
  return null;
}

export interface BlockDecision { block: boolean; tracker?: string }

/**
 * Should this request be blocked?
 *
 * @param requestUrl  the request
 * @param pageUrl     the top-level page it was made for ('' when unknown)
 * @param resourceType Electron's resourceType ('mainFrame' is never blocked)
 */
export function shouldBlock(requestUrl: string, pageUrl: string, resourceType: string): BlockDecision {
  if (resourceType === 'mainFrame') return { block: false };
  let reqHost: string;
  try {
    const u = new URL(requestUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'ws:' && u.protocol !== 'wss:') return { block: false };
    reqHost = u.hostname;
  } catch { return { block: false }; }
  const tracker = trackerDomainFor(reqHost);
  if (!tracker) return { block: false };
  let pageHost = '';
  try { pageHost = pageUrl ? new URL(pageUrl).hostname : ''; } catch { /* no page yet */ }
  // First party: the site's own analytics host (or the tracker's own site) is not blocked.
  if (pageHost && registrableDomain(pageHost) === registrableDomain(reqHost)) return { block: false };
  return { block: true, tracker: reqHost.toLowerCase() };
}

/** The origin (scheme://host[:port]) of a URL, or '' for non-web URLs. */
export function originOf(url: string): string {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : '';
  } catch { return ''; }
}
