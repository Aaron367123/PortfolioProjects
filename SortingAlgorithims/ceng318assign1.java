package ceng318assign1;
import java.util.*;
/**
 *
 * @author Aaron Jara
 */
public class CENG318Assign1 {

    public static void SelectionSortDes(int[]arr){
	for (int start = 0; start < arr.length; start++) {
            int min = start;
            for (int loc = start + 1; loc < arr.length; loc++) {
                if (arr[loc] > arr[min]) {
                    min = loc;
                }
            }
            int temp = arr[start];
            arr[start] = arr[min];
            arr[min] = temp;
        }
    }
    
    public static void InsertionSortDes(int[]arr){
	for(int start = 1; start < arr.length; start++){
            int prev = start - 1;
            int temp = arr[start];
            while(prev >= 0 && arr[prev] < temp){
		arr[prev+1] = arr[prev];
		prev--;
            }
            arr[prev+1] = temp;
	}
    }
    
    public static void merge(int arr[], int lower, int middle, int upper){ 
        int i, j, k; 
        int left[]=new int[middle-lower+1];
        int right[]=new int[upper-middle];
        
        for (i = 0; i < middle-lower+1; i++)
            left[i] = arr[lower + i];
        for (j = 0; j < upper-middle; j++) 
            right[j] = arr[middle + 1 + j];
        i = 0;
        j = 0;
         
        for (k = lower;i < middle-lower+1 && j < upper-middle;k++){
            if (left[i] >= right[j]) 
                arr[k] = left[i++];
            else 
                arr[k] = right[j++];
        }
        
        while (i < middle-lower+1) arr[k++] = left[i++];
        while (j < upper-middle) arr[k++] = right[j++];
    }
     
    public static void mergeSort(int arr[],int lower,int upper){
        if(lower>=upper)
            return;
        int mid = (lower + upper)/2;
        mergeSort(arr, lower, mid);
        mergeSort(arr, mid + 1, upper);
        merge(arr, lower, mid, upper);
    }
    
    static void swap(int[] arr, int i, int j){
        int temp = arr[i];
        arr[i] = arr[j];
        arr[j] = temp;
    }
    
    static int partition(int[] arr, int low, int high){
        int pivot = arr[high];
        int i = (low - 1);
 
        for (int j = low; j <= high - 1; j++) {
            if (arr[j] > pivot) {
                i++;
                swap(arr, i, j);
            }
        }
        swap(arr, i + 1, high);
        return (i + 1);
    }
 
    static void quickSort(int[] arr, int low, int high){
        if (low < high){
            int pi = partition(arr, low, high);
            quickSort(arr, low, pi - 1);
            quickSort(arr, pi + 1, high);
        }
    }

    public static int LinearSearch(int[] arr,int key){
	for(int pos= 0; pos<arr.length - 1;pos++){
            if(arr[pos] == key)
                return pos;
        }
        return -1;
    }
    
    public static int BinarySearch(int[] arr, int key){
	int lo = 0;
	int hi = arr.length-1;
	int mid;

	while (lo <= hi){
		mid = (lo+hi)/2;
		if(arr[mid]==key)
			return mid;
		if(arr[mid]<key)
			hi= mid- 1;
                else
			lo=mid+1;
	}
        return -1;
    }

    public static void main(String[] args) {
        int[] coreData;
        coreData = new int[50];
        Random rand =new Random();
        
        for (int i = 0; i < coreData.length; i++){
            coreData[i] = rand.nextInt(1, 2000001);
        }
        
        int[] arrayS = coreData.clone();
        int[] arrayI = coreData.clone();
        int[] arrayM = coreData.clone();
        int[] arrayQ = coreData.clone();
        
        long start = System.nanoTime();
        SelectionSortDes(arrayS);
        long end = System.nanoTime();
        long timeTaken = end - start;
        System.out.println("Selection sort" + Arrays.toString(arrayS));
        System.out.println("The time it took to selection sort array " + timeTaken + " nanoseconds");
        
        start = System.nanoTime();
        InsertionSortDes(arrayI);
        end = System.nanoTime();
        timeTaken = end - start;
        System.out.println("\nInsertion sort" + Arrays.toString(arrayI));
        System.out.println("The time it took to insertion sort array " + timeTaken + " nanoseconds");
        
        start = System.nanoTime();
        mergeSort(arrayM, 0, arrayM.length - 1);
        end = System.nanoTime();
        timeTaken = end - start;
        System.out.println("\nMerge sort" + Arrays.toString(arrayM));
        System.out.println("The time it took to merge sort array " + timeTaken + " nanoseconds");
        
        start = System.nanoTime();
        quickSort(arrayQ, 0, arrayQ.length - 1);
        end = System.nanoTime();
        timeTaken = end - start;
        System.out.println("\nQuick sort" + Arrays.toString(arrayQ));
        System.out.println("The time it took to quick sort array " + timeTaken + " nanoseconds");
        
        int key = 2500000; 
        
        start = System.nanoTime();
        int result2 = BinarySearch(arrayS, key);
        end = System.nanoTime();
        timeTaken = end - start;
        if (result2 == -1)
            System.out.print("\nElement is not present in array");
        else
            System.out.print("\nElement is present at index " + result2);
        System.out.println("\nThe time it took to binary search array " + timeTaken + " nanoseconds");
        
        start = System.nanoTime();
        int result = LinearSearch(arrayS, key);
        end = System.nanoTime();
        timeTaken = end - start;
        if (result == -1)
            System.out.print("\nElement is not present in array");
        else
            System.out.print("\nElement is present at index " + result);
        System.out.println("\nThe time it took to linear search array " + timeTaken + " nanoseconds");
    }
}
