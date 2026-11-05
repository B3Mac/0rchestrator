glabel Game_LoseLife
    /* 1034 80001034 */  lui        $v1, %hi(gLives)
    /* 1038 80001038 */  lw         $v0, %lo(gLives)($v1)
    /* 103C 8000103C */  blez       $v0, .L8000104C
    /* 1040 80001040 */   nop
    /* 1044 80001044 */  addiu      $v0, $v0, -1
    /* 1048 80001048 */  sw         $v0, %lo(gLives)($v1)
.L8000104C:
    /* 104C 8000104C */  jr         $ra
    /* 1050 80001050 */   nop
endlabel Game_LoseLife
