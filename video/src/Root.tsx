import React from 'react';
import { Composition } from 'remotion';
import { Short, Full, SHORT_DURATION, FULL_DURATION } from './Demo';

export const Root: React.FC = () => (
  <>
    <Composition id="Short" component={Short} durationInFrames={SHORT_DURATION} fps={30} width={1920} height={1080} />
    <Composition id="Full" component={Full} durationInFrames={FULL_DURATION} fps={30} width={1920} height={1080} />
  </>
);
