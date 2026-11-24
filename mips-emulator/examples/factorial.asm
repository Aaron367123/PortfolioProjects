# Recursive factorial: fact(n) = n * fact(n - 1), fact(0) = 1.
# Shows: jal / jr, the stack ($sp), sw / lw of $ra, mul, beq, and printing.

            .data
n:          .word   6
msg:        .asciiz "6! = "

            .text
main:       la    $t0, n
            lw    $a0, 0($t0)         # argument: n
            jal   fact                # $v0 = fact(n)
            move  $s0, $v0

            li    $v0, 4              # print "6! = "
            la    $a0, msg
            syscall
            li    $v0, 1              # print the result (expected 720)
            move  $a0, $s0
            syscall
            li    $v0, 10             # exit
            syscall

# int fact(int n)   argument in $a0, result in $v0
fact:       addi  $sp, $sp, -8        # make room for two words on the stack
            sw    $ra, 4($sp)         # save the return address
            sw    $a0, 0($sp)         # save n

            bne   $a0, $zero, recurse # n != 0 -> recursive case
            li    $v0, 1              # fact(0) = 1
            addi  $sp, $sp, 8
            jr    $ra

recurse:    addi  $a0, $a0, -1
            jal   fact                # $v0 = fact(n - 1)
            lw    $a0, 0($sp)         # restore n
            lw    $ra, 4($sp)         # restore the return address
            addi  $sp, $sp, 8
            mul   $v0, $a0, $v0       # n * fact(n - 1)
            jr    $ra
