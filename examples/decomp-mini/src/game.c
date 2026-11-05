#include "common.h"

s32 gScore;
s32 gLives = 3;

s32 Game_GetScore(void) {
    return gScore;
}

INCLUDE_ASM("asm/nonmatchings/game", Game_AddScore);

INCLUDE_ASM("asm/nonmatchings/game", Game_LoseLife);

INCLUDE_ASM("asm/nonmatchings/game", Game_Clamp);

INCLUDE_ASM("asm/nonmatchings/game", Game_SumArray);
