import React from 'react';
import type {DirectorDirection, MotionFrame} from '../../web/src/types/director-motion';

type Point = {x: number; y: number};
const locations: Record<string, Point> = {
  'table.left': {x: 205, y: 515},
  'teacher.right_hand': {x: 430, y: 390},
  'student.left_hand': {x: 850, y: 390},
  'table.right': {x: 1075, y: 515},
};
const arm = (shoulder: Point, hand: Point, color: string) => {
  const elbow = {x: (shoulder.x + hand.x) / 2, y: (shoulder.y + hand.y) / 2 + 48};
  return <g stroke={color} strokeWidth={22} strokeLinecap="round"><path d={`M ${shoulder.x} ${shoulder.y} L ${elbow.x} ${elbow.y} L ${hand.x} ${hand.y}`} fill="none"/><circle cx={hand.x} cy={hand.y} r={13} fill={color} stroke="none"/></g>;
};

// Geometry consumes the shared evaluator's progress and token arc. It contains
// no clock, spring or independent easing; holder states are the exported facts.
export const ContinuityView: React.FC<{direction: DirectorDirection; state: MotionFrame}> = ({direction, state}) => {
  const start = locations[direction.continuity.statesIn['paper.holder']];
  const end = locations[direction.continuity.statesOut['paper.holder']];
  if (!start || !end) throw new Error('Unknown greybox prop holder');
  const p = state.actionProgress;
  const token = state.nodes.find((node) => node.id === 'token');
  if (!token) throw new Error('Continuity view requires the shared object-relay token');
  const prop = {x: start.x + (end.x - start.x) * p, y: start.y + (end.y - start.y) * p + (token.y - .55) * 200};
  let teacher = locations['teacher.right_hand'];
  let student = locations['student.left_hand'];
  if (start === locations['table.left'] || end === locations['teacher.right_hand']) teacher = prop;
  else if (start === locations['teacher.right_hand']) {
    const release = Math.max(0, p * 2 - 1);
    teacher = {x: prop.x + (teacher.x - prop.x) * release, y: prop.y + (teacher.y - prop.y) * release};
  }
  if (start === locations['student.left_hand'] || end === locations['table.right']) student = prop;
  else if (end === locations['student.left_hand']) {
    const reach = Math.min(1, p * 2);
    student = {x: student.x + (prop.x - student.x) * reach, y: student.y + (prop.y - student.y) * reach};
  }
  return <svg width="100%" height="100%" viewBox="0 0 1280 720" role="img" aria-label={direction.content.title} style={{fontFamily: 'Microsoft YaHei,sans-serif'}}>
    <rect width="1280" height="720" fill="#111820"/>
    <text x="85" y="112" fill="#ecf2f4" fontSize="42" fontWeight="600">{direction.content.title}</text>
    <path d="M85 592H1195" stroke="#6b7785" strokeWidth="3"/>
    <g fill="#334251"><rect x="110" y="520" width="210" height="25" rx="8"/><rect x="115" y="545" width="16" height="48"/><rect x="292" y="545" width="16" height="48"/><rect x="960" y="520" width="210" height="25" rx="8"/><rect x="966" y="545" width="16" height="48"/><rect x="1148" y="545" width="16" height="48"/></g>
    <g fill="#91a8b7"><circle cx="355" cy="275" r="45"/><rect x="310" y="326" width="90" height="146" rx="24"/><path d="M327 470V587M382 470V587" fill="none" stroke="#91a8b7" strokeWidth="24" strokeLinecap="round"/></g>
    <g fill="#b6c7ce"><circle cx="925" cy="275" r="45"/><rect x="880" y="326" width="90" height="146" rx="24"/><path d="M898 470V587M952 470V587" fill="none" stroke="#b6c7ce" strokeWidth="24" strokeLinecap="round"/></g>
    {arm({x: 390, y: 345}, teacher, '#91a8b7')}
    {arm({x: 890, y: 345}, student, '#b6c7ce')}
    <g transform={`translate(${prop.x} ${prop.y})`}><rect x="-32" y="-24" width="64" height="48" rx="5" fill="#eff5ec"/><path d="M-21 -11H21M-21 0H21M-21 11H7" stroke="#5f7582" strokeWidth="3"/></g>
    <text x="355" y="650" fill="#ecf2f4" textAnchor="middle" fontSize="28">教师</text>
    <text x="925" y="650" fill="#ecf2f4" textAnchor="middle" fontSize="28">学生</text>
  </svg>;
};
