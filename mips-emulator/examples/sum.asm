# Sum the numbers in an array and print the result.
# Shows: la, lw, add, addi, blt, and syscalls 4 (print string), 1 (print int), 10 (exit).

            .data
numbers:    .word   12, 7, -3, 25, 40, 9, 100, 10   # 8 words
count:      .word   8
label:      .asciiz "Sum = "

            .text
main:       la    $t0, numbers        # $t0 = pointer to the current element
            la    $t1, count
            lw    $t1, 0($t1)         # $t1 = number of elements
            li    $t2, 0              # $t2 = index i
            li    $s0, 0              # $s0 = running sum

loop:       bge   $t2, $t1, done      # stop when i >= count
            lw    $t3, 0($t0)         # $t3 = numbers[i]
            add   $s0, $s0, $t3       # sum += numbers[i]
            addi  $t0, $t0, 4         # next word
            addi  $t2, $t2, 1         # i++
            j     loop

done:       li    $v0, 4              # print "Sum = "
            la    $a0, label
            syscall
            li    $v0, 1              # print the sum (expected 200)
            move  $a0, $s0
            syscall
            li    $v0, 10             # exit
            syscall
