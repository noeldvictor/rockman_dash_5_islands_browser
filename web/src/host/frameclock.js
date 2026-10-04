// Counts presented game frames. Drawing instances use it to tell whether they were also drawn
// in the previous frame, i.e. whether there is a previous pose to show in-between pictures from.
export const frameClock = { frame: 0 };
