$(function () {
    $('.error').hide()
    $("#feedback_btn").click(function () {
        let checked = true

        $('.error').hide()
        var name = $("input#name").val()
        if (name === "") {
            $("label#name_missing_error").show()
            $("input#name").focus()
            checked = false
        }

        var mail = $("input#mail").val()
        if (mail === "") {
            $("label#email_missing_error").show()
            $("input#mail").focus()
            checked = false
        } 

        var feed = $("input#feed").val()
        if (feed === "") {
            $("label#feedback_missing_error").show()
            $("input#feed").focus()
            checked = false
        } 

        if (checked) {
            console.log("First name: " + name + "\n" +"Email: " + mail + "\n" +"Feedback: "+ feed + "\n" )
            
            return true
        }
        return false
    })
})