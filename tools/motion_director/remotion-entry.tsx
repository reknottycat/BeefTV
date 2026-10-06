import React from 'react';
import {AbsoluteFill, Composition, Img, registerRoot, useCurrentFrame, useVideoConfig} from 'remotion';
import type {Caption} from '@remotion/captions';
import {evaluateDirectorMotion, renderDirectorMotionSvg} from '../../web/src/lib/canvas/director/director-motion';
import type {DirectorTimeline} from '../../web/src/lib/canvas/director/director-timeline';
import {canonicalDirectorJson, compileDirectorTimeline} from '../../web/src/lib/canvas/director/director-timeline';
import type {DirectorScene} from '../../web/src/types/director';
import {ContinuityView} from './continuity-view';

export type DirectorRenderInput = {
  timeline: DirectorTimeline;
  captions?: Caption[];
  width?: number;
  height?: number;
  presentation?: 'motion' | 'continuity-greybox';
  scene?: DirectorScene;
};

// The workbench and this consumer call the same frame evaluator. Only the outer
// caption safe area belongs to the Remotion adapter; no animation is duplicated.
export const DirectorVideo: React.FC<DirectorRenderInput> = ({timeline, captions = [], presentation = 'motion'}) => {
  const frame = useCurrentFrame();
  const {width, height, fps} = useVideoConfig();
  const shot = timeline.shots.find((item) => frame >= item.startFrame && frame < item.endFrame);
  if (!shot?.direction) throw new Error(`No executable direction at frame ${frame}`);
  const svg = renderDirectorMotionSvg(shot.direction, frame - shot.startFrame, shot.durationFrames, fps, {width, height});
  const caption = captions.find((item) => frame * 1000 / fps >= item.startMs && frame * 1000 / fps < item.endMs);
  return <AbsoluteFill style={{backgroundColor: '#07101d'}}>
    {presentation === 'continuity-greybox' ? <ContinuityView direction={shot.direction} state={evaluateDirectorMotion(shot.direction, frame - shot.startFrame, shot.durationFrames, fps)}/> : <Img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`} width={width} height={height} />}
    {caption && <div data-caption style={{position: 'absolute', left: '7%', right: '7%', bottom: '5%', textAlign: 'center', color: '#fff', fontFamily: 'Microsoft YaHei, sans-serif', fontSize: height * 0.042, fontWeight: 600, lineHeight: 1.4, textShadow: '0 2px 8px #000', backgroundColor: 'rgba(7,16,29,.8)', borderRadius: 8, padding: '8px 16px'}}>{caption.text}</div>}
  </AbsoluteFill>;
};

const Root = () => <Composition
  id="DirectorMotion"
  component={DirectorVideo}
  defaultProps={{timeline: {schemaVersion: 1, fps: 30, totalFrames: 1, shots: [], audioCues: []} as unknown as DirectorTimeline}}
  durationInFrames={1}
  fps={30}
  width={1280}
  height={720}
  calculateMetadata={({props}) => {
    if (props.scene && canonicalDirectorJson(compileDirectorTimeline(props.scene, props.timeline.fps)) !== canonicalDirectorJson(props.timeline)) throw new Error('Saved scene and compiled timeline differ');
    return {durationInFrames: props.timeline.totalFrames, fps: props.timeline.fps, width: props.width ?? 1280, height: props.height ?? 720};
  }}
/>;

registerRoot(Root);
