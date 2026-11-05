glabel Game_AddScore
    /* 1010 80001010 */  sll        $v0, $a0, 2
    /* 1014 80001014 */  addu       $v0, $v0, $a0
    /* 1018 80001018 */  lui        $v1, %hi(gScore)
    /* 101C 8000101C */  lw         $v1, %lo(gScore)($v1)
    /* 1020 80001020 */  sll        $v0, $v0, 1
    /* 1024 80001024 */  addu       $v1, $v1, $v0
    /* 1028 80001028 */  lui        $at, %hi(gScore)
    /* 102C 8000102C */  jr         $ra
    /* 1030 80001030 */   sw        $v1, %lo(gScore)($at)
endlabel Game_AddScore
