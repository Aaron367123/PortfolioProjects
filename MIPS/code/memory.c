/*
============================================================================
Name    : Lab6.c
Author  : Austin Tian
Revised by : Aaron Morris Basco Jara
Version : 1
Copyright : Copyright 2023
Description : Lab 6 in C, ANSI-C Style
============================================================================
*/

#include "header.h"

// Menu for the testing.
char *menu = "\n" \
" ***********Please select the following options**********************\n" \
" * This is the memory operation menu (Lab 6) *\n" \
" ********************************************************************\n" \
" * 1. Write a double-word (32-bit) to the memory *\n" \
" ********************************************************************\n" \
" * 2. Read a byte (8-bit) data from the memory *\n" \
" * 3. Read a double-word (32-bit) data from the memory *\n" \
" ********************************************************************\n" \
" * 4. Generate a memory dump from any memory location *\n" \
" ********************************************************************\n" \
" * e. To Exit, Type 'e' or 'E' *\n" \
" ********************************************************************\n";

//---------------------------------------------------------------
// Generate a random number between 0x00 and 0xFF.
unsigned char rand_generator() {
    return rand() % 255; // generate a random number between 0 and 255.
}

//---------------------------------------------------------------
void free_memory(char *base_address) {
    free(base_address); // free memory after use to avoid memory leakage.
    return;
}

//---------------------------------------------------------------
char *init_memory() {
    char *mem = malloc(MEM_SIZE); // allocate the memory
    // step 1: Start filling in the memory contents with
    // random number generated by rand_generator() etc.
    /*for (int i = 0; i < MEM_SIZE; ++i) {
        mem[i] = rand_generator(); // fill memory with random data from rand_generator
    }*/
    memset(mem, 0, MEM_SIZE);
    return mem;
}

//---------------------------------------------------------------
void write_dword(const char *base_address, const int offset, const unsigned int dword_data) {
    // Step 2: write a double-word to address: "base_address + offset".
    unsigned int *ptr = (base_address + offset);
    *ptr = dword_data; // Copy dword to *ptr
    //printf("Double-word written successfully.\n"); // Print dword was written
}

//---------------------------------------------------------------
unsigned char read_byte(const char *base_address, const int offset) {
    // Step 3: return and print the byte from address: "base_address + offset".
    unsigned char *ptr = (base_address + offset);
    unsigned char byte = *ptr; // Dereference the pointer to read the byte value
    printf("Byte at offset %d: %02X\n", offset, byte); // Print the byte value and its offset
    return byte;
}

//---------------------------------------------------------------
unsigned int read_dword(const char *base_address, const int offset) {
    // Step 4: return and print the double-word from address: "base_address + offset".
    unsigned int *ptr = (base_address + offset);
    unsigned int dword = *ptr; // Dereference the pointer to read the double-word value
    printf("Double-word at offset %X: %08X\n", base_address + offset, dword); // Print the double-word value and its offset
    return dword;
}

//---------------------------------------------------------------
void memory_dump(const char *base_address, const int offset, unsigned int dumpsize) {
    // Step 5: Generate a memory dump display starting from address "base_address + offset".
    // i.e., Display the contents of dump_size bytes starting from "base_address + offset"
    // dump_size should be a parameter.
    // The memory dump display should be similar to the screenshot on the lab manual.
    if (dumpsize < MIN_DUMP_SIZE || dumpsize > MEM_SIZE)
        dumpsize = MIN_DUMP_SIZE; // make sure the min dumpsize is 256
    // Loop through the memory dump in chunks of DUMP_LINE bytes
    for (int i = 0; i < dumpsize; i += DUMP_LINE) {
        printf("%06X: ", (unsigned int)base_address + offset + i); // Print the starting address for each line
        // Print memory contents in HEX
        for (int j = 0; j < DUMP_LINE; ++j) {
            if (i + j < dumpsize) { // Check if it is in the bounds of the memory dump
                printf("%02X ", (unsigned char)base_address[offset + i + j]); // Print the hexadecimal representation of each byte
            } else {
                printf(" "); // Print spaces for padding if end of memory reached
            }
        }
        printf(" "); // Space between HEX and ASCII representation
        // Print memory contents in ASCII
        for (int j = 0; j < DUMP_LINE && i + j < dumpsize; ++j) {
            char c = base_address[offset + i + j]; // Get the character at the current memory address
            if (c >= 0x20 && c <= 0x7E) { // Check if the character is printable
                printf("%c", c); // Printable character
            } else {
                printf("."); // Non-printable character print a .
            }
        }
        printf("\n"); // Print new line
    }
}

//---------------------------------------------------------------
void setup_memory() {
    // Now we need to setup the memory controller for the computer system we
    // will build. Basic requirements:
    // 1. Memory size needs to be 1M Bytes
    // 2. Memory is readable/writable with Byte and Double-Word Operations.
    // 3. Memory can be dumped and shown on screen.
    // 4. Memory needs to be freed (released) at the end of the code.
    // 6. For lab 6, we need to have a user interface to fill in memory,
    // read memory and do memory dump.
    char *mem = init_memory(); // initialize the memory.
    char options =0;
    unsigned int offset, dumpsize;
    char tempchar;
    unsigned int dword_data; // 32-bit operation.
    do {
        if (options != 0x0a) // if options has a return key input, skip it.
        {
            puts(menu); /* prints Memory Simulation */
            printf ("\nThe base address of your memory is: %I64Xh (HEX)\n", (long long unsigned int)(mem)); // output base memory first.
            puts("Please make a selection:"); // output base memory first.
        }
        options = getchar();
        switch (options) {
            case '1': // write double word.
                puts("Please input your memory's offset address (in HEX):");
                scanf("%x", (unsigned int*)&offset); // input an offset address (in HEX) to write.
                puts("Please input your DOUBLE WORD data to be written (in HEX):");
                scanf("%x", (unsigned int*)&dword_data); // input data
                write_dword (mem, offset, dword_data); // write a double word to memory.
                continue;
            case '2': // read byte.
                puts("Please input your memory's offset address (in HEX):");
                scanf("%x", &offset); // input an offset address (in HEX) to write.
                read_byte(mem, offset);
                continue;
            case '3': // read double word.
                puts("Please input your memory's offset address (in HEX):");
                scanf("%x", &offset); // input an offset address (in HEX) to write.
                read_dword(mem, offset);
                continue;
            case '4': // generate memory dump starting at offset address (in HEX).
                puts("Please input your memory's offset address (in HEX, should be a multiple of 0x10h):");
                scanf("%x", &offset); // input an offset address (in HEX) to start.
                puts("Please input the size of the memory to be dumped (a number between 256 and 1024 ):");
                scanf("%d", &dumpsize); // The size of the memory dump
                memory_dump(mem, offset, dumpsize); // generate a memory dump display of dumpsize bytes.
                continue;
            case 'e':
            case 'E':
                puts("Code finished, press any key to exit");
                free_memory(mem);
                while ((tempchar = getchar()) != '\n' && tempchar != EOF); // wait for the enter.
                tempchar = getchar();
                return; // return to main program.
            default:
                // puts("Not a valid entry, please try again");
                continue;
        }
    } while (1); // make sure the only exit is from 'e'.
    return;
}