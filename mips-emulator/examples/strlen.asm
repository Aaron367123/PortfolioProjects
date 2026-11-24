# String length and upper-casing, one byte at a time.
# Shows: lb / sb, beq, blt / bgt with character literals, and printing.

            .data
text:       .asciiz "hello, mips!"
newline:    .asciiz "\n"
lenmsg:     .asciiz "length = "

            .text
main:       la    $t0, text           # $t0 = pointer into the string
            li    $t1, 0              # $t1 = length
            li    $t4, 'a'
            li    $t5, 'z'

loop:       lb    $t2, 0($t0)         # load one character
            beq   $t2, $zero, done    # NUL terminator -> end of string
            blt   $t2, $t4, next      # not a lowercase letter
            bgt   $t2, $t5, next
            addi  $t2, $t2, -32       # 'a' - 'A' = 32
            sb    $t2, 0($t0)         # write the upper-case letter back
next:       addi  $t0, $t0, 1
            addi  $t1, $t1, 1
            j     loop

done:       li    $v0, 4              # print the modified string
            la    $a0, text
            syscall
            la    $a0, newline
            syscall
            la    $a0, lenmsg         # print "length = 12"
            syscall
            li    $v0, 1
            move  $a0, $t1
            syscall
            li    $v0, 10
            syscall
