export const TAG_REGEX =
    /(?:(\d+)[Dd])?(#[\p{Letter}\p{Emoji_Presentation}\w/-]+)(?:\|([\+-]))?(?:\|([^\+-]+))?/u;
export const TABLE_REGEX =
    /(?:(\d+)[Dd])?\[\[([\s\S]+?)#?\^([\s\S]+?)\]\]\|?([\s\S]+)?/;
export const SECTION_REGEX = /(?:(\d+)[Dd])?\[\[([\s\S]+)\]\]\|?([\s\S]+)?/;
export const MATH_REGEX = /[\(\^\+\-\*\/\)]/;
