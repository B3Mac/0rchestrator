glabel Game_SumArray
    /* 1084 80001084 */  blez       $a1, .L800010AC
    /* 1088 80001088 */   move      $v0, $zero
    /* 108C 8000108C */  move       $v1, $zero
.L80001090:
    /* 1090 80001090 */  lw         $a2, 0x0($a0)
    /* 1094 80001094 */  addiu      $v1, $v1, 1
    /* 1098 80001098 */  addu       $v0, $v0, $a2
    /* 109C 8000109C */  slt        $at, $v1, $a1
    /* 10A0 800010A0 */  bnez       $at, .L80001090
    /* 10A4 800010A4 */   addiu     $a0, $a0, 4
.L800010AC:
    /* 10AC 800010AC */  jr         $ra
    /* 10B0 800010B0 */   nop
endlabel Game_SumArray
