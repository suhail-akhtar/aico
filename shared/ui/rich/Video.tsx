/**
 * ```video — YouTube videos as thumbnails that become players on click.
 *
 * Nothing from YouTube loads but the thumbnail until the reader asks for the
 * video: the player comes from youtube-nocookie.com, and only on click. A
 * transcript with five videos in it should not start five players, or tell a
 * third party about each of them, just by being scrolled past.
 *
 * @module shared/ui/rich/Video
 */

import React, { useState } from 'react';
import { Arriving, Carousel, ExtLink, Icon, SafeImg, useParsed } from './common';
import { hostOf, parseVideo, youtubeEmbed, youtubeThumb, type VideoItem, type VideoSpec } from './specs';

export function Video({ source, streaming = false }: { source: string; streaming?: boolean }): React.ReactElement {
  const { spec, waiting } = useParsed(source, streaming, parseVideo);
  if (waiting || !spec) return <Arriving what="Video" />;
  return <VideoView spec={spec} />;
}

function VideoView({ spec }: { spec: VideoSpec }): React.ReactElement {
  const [playing, setPlaying] = useState<number | null>(null);
  const single = spec.videos.length === 1;
  const current = spec.videos.find(v => v.id === playing);

  return (
    <div className="aw aw-video">
      {spec.title && <div className="aw-heading">{spec.title}</div>}
      {single ? (
        <VideoCard video={spec.videos[0]!} playing={playing === spec.videos[0]!.id} onPlay={setPlaying} large />
      ) : (
        <>
          {current?.youtube && (
            <div className="aw-player-main">
              <Player video={current} />
              <Caption video={current} />
            </div>
          )}
          <Carousel label="Videos">
            {spec.videos.map(v => (
              <VideoCard key={v.id} video={v} playing={false} active={playing === v.id} onPlay={setPlaying} />
            ))}
          </Carousel>
        </>
      )}
    </div>
  );
}

function Player({ video }: { video: VideoItem }): React.ReactElement {
  return (
    <div className="aw-player">
      <iframe
        src={youtubeEmbed(video.youtube!, video.start)}
        title={video.title ?? 'YouTube video'}
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        referrerPolicy="strict-origin-when-cross-origin"
        allowFullScreen
      />
    </div>
  );
}

/**
 * Under a playing video. Always carries a link to the video on YouTube: an
 * owner can forbid embedding, and then the player says "unavailable" with the
 * video one click away — this makes that click obvious.
 */
function Caption({ video }: { video: VideoItem }): React.ReactElement {
  return (
    <div className="aw-video-caption">
      {video.title && <ExtLink href={video.url} className="aw-video-title">{video.title}</ExtLink>}
      <div className="aw-video-meta">
        {video.channel && <span>{video.channel}</span>}
        {video.channel && video.duration && <span className="aw-dot">·</span>}
        {video.duration && <span>{video.duration}</span>}
        <span className="aw-grow" />
        <ExtLink href={video.url} className="aw-video-out"><Icon name="external" size={11} /> Watch on YouTube</ExtLink>
      </div>
    </div>
  );
}

function VideoCard({ video, playing, active = false, onPlay, large = false }: {
  video: VideoItem; playing: boolean; active?: boolean; onPlay: (id: number) => void; large?: boolean;
}): React.ReactElement {
  if (playing && video.youtube) {
    return (
      <div className={`aw-video-card${large ? ' is-large' : ''}`}>
        <Player video={video} />
        <Caption video={video} />
      </div>
    );
  }
  const thumb = video.youtube ? youtubeThumb(video.youtube) : undefined;
  const body = (
    <>
      <div className="aw-video-thumb">
        <SafeImg src={thumb} alt="" fallback={<span className="aw-video-ph"><Icon name="play" size={26} /></span>} />
        <span className="aw-play" aria-hidden="true"><Icon name="play" size={large ? 22 : 18} /></span>
        {video.duration && <span className="aw-duration">{video.duration}</span>}
      </div>
      <div className="aw-video-caption">
        <div className="aw-video-title" title={video.title}>{video.title ?? (video.youtube ? 'YouTube video' : hostOf(video.url) ?? video.url)}</div>
        {(video.channel || !video.youtube) && (
          <div className="aw-video-meta">
            {video.channel ?? hostOf(video.url)}
          </div>
        )}
      </div>
    </>
  );
  // Only YouTube embeds; anything else is a link card to the page itself.
  if (!video.youtube) {
    return <ExtLink href={video.url} className={`aw-video-card${large ? ' is-large' : ''}`}>{body}</ExtLink>;
  }
  return (
    <button
      type="button"
      role="listitem"
      className={`aw-video-card${large ? ' is-large' : ''}${active ? ' is-active' : ''}`}
      onClick={() => onPlay(video.id)}
      aria-label={`Play ${video.title ?? 'video'}`}
    >
      {body}
    </button>
  );
}
